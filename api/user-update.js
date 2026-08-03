const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const { rateLimit }   = require("../lib/ratelimit");
const { subscriptionDates, extendPeriodEnd, ensureSubscriptionColumns } = require("../lib/subscription");
const Stripe          = require("stripe");
const { Resend }      = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  // ── GET /api/user-update?action=me → Profil utilisateur ────────
  if (req.method === "GET" && req.query.action === "me") {
    try {
      await ensureSubscriptionColumns();
      const [u] = await sql`
        SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.plan, u.subscribed,
               u.authorized, u.email_verified, u.gym_id, u.referral_code, u.free_months,
               u.sub_started_at, u.sub_expires_at, u.cancel_at_period_end,
               g.name AS gym_name,
               (SELECT COUNT(*) FROM users WHERE referred_by = u.id AND subscribed = true) AS ref_count
        FROM users u LEFT JOIN gyms g ON u.gym_id = g.id
        WHERE u.id = ${auth.id}
      `;
      if (!u) return res.status(404).json({ error: "Utilisateur introuvable." });
      if (u.subscribed && u.sub_expires_at && new Date(u.sub_expires_at) < new Date()) {
        u.subscribed = false;
        sql`UPDATE users SET subscribed = false WHERE id = ${u.id}`.catch(() => {});
      }
      return res.json({
        user: {
          id: u.id, name: `${u.first_name} ${u.last_name}`,
          email: u.email, phone: u.phone,
          initials: ((u.first_name||'?')[0] + (u.last_name||'?')[0]).toUpperCase(),
          plan: u.plan, subscribed: u.subscribed, authorized: u.authorized,
          gym: u.gym_name || null, gym_id: u.gym_id,
          referral_code: u.referral_code,
          referral_count: parseInt(u.ref_count) || 0,
          free_months: u.free_months,
          email_verified: u.email_verified,
          ...subscriptionDates(u.sub_started_at, u.sub_expires_at, u.plan),
        }
      });
    } catch (e) {
      console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." });
    }
  }

  // ── GET /api/user-update?action=history → Historique des scans ─
  if (req.method === "GET" && req.query.action === "history") {
    try {
      const rows = await sql`
        SELECT s.scanned_at, g.name AS gym_name
        FROM scans s LEFT JOIN gyms g ON s.gym_id = g.id
        WHERE s.user_id = ${auth.id}
        ORDER BY s.scanned_at DESC LIMIT 50
      `;
      const tz = "Europe/Zurich";
      const now = new Date();
      const todayStr  = now.toLocaleDateString("fr-CH", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      const yesterdayStr = new Date(now - 86400000).toLocaleDateString("fr-CH", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
      const thisMonthStr  = now.toLocaleDateString("fr-CH", { timeZone: tz, year: "numeric", month: "2-digit" });
      const history = rows.map(s => {
        const d = new Date(s.scanned_at);
        const dayStr   = d.toLocaleDateString("fr-CH", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
        const monthStr = d.toLocaleDateString("fr-CH", { timeZone: tz, year: "numeric", month: "2-digit" });
        const isToday = dayStr === todayStr;
        const isYest  = dayStr === yesterdayStr;
        const isMonth = monthStr === thisMonthStr;
        const hm = d.toLocaleTimeString("fr-CH", { hour: "2-digit", minute: "2-digit", timeZone: tz });
        const timeStr = isToday ? `Auj. ${hm}` : isYest ? `Hier ${hm}`
          : `${d.toLocaleDateString("fr-CH", { day: "numeric", month: "short", timeZone: tz })} ${hm}`;
        return { gym: s.gym_name || "Fitness VOLT", time: timeStr, today: isToday, month: isMonth };
      });
      return res.json({ history });
    } catch (e) {
      return res.status(500).json({ error: "Erreur serveur." });
    }
  }

  // ── DELETE /api/user-update?action=clear-history ───────────────
  if (req.method === "DELETE" && req.query.action === "clear-history") {
    try {
      await sql`DELETE FROM scans WHERE user_id = ${auth.id}`;
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: "Erreur serveur." });
    }
  }

  // ── POST /api/user-update → Modifier le profil ─────────────────
  if (req.method === "POST" && !req.query.action) {
    const { firstName, lastName, email, phone } = req.body || {};
    if (!firstName || !lastName || !email)
      return res.status(400).json({ error: "Champs obligatoires manquants." });
    try {
      const [existing] = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()} AND id != ${auth.id}`;
      if (existing) return res.status(400).json({ error: "Cette adresse email est déjà utilisée." });
      await sql`
        UPDATE users
        SET first_name = ${firstName},
            last_name  = ${lastName},
            email      = ${email.toLowerCase()},
            phone      = ${phone || null}
        WHERE id = ${auth.id}
      `;
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: "Erreur serveur." });
    }
  }

  // ── DELETE /api/user-update → Supprimer le compte ──────────────
  if (req.method === "DELETE") {
    try {
      const [userData] = await sql`SELECT stripe_customer FROM users WHERE id = ${auth.id}`;
      if (userData?.stripe_customer) {
        try {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          const subs = await stripe.subscriptions.list({
            customer: userData.stripe_customer,
            status: 'active',
            limit: 1,
          });
          if (subs.data.length > 0) {
            await stripe.subscriptions.cancel(subs.data[0].id);
          }
        } catch (stripeErr) {
          console.error("Stripe cancel on delete:", stripeErr);
        }
      }

      await sql`DELETE FROM qr_tokens    WHERE user_id = ${String(auth.id)}`;
      await sql`DELETE FROM cooldowns    WHERE user_id = ${auth.id}`;
      await sql`DELETE FROM scans        WHERE user_id = ${auth.id}`;
      await sql`DELETE FROM verify_tokens WHERE user_id = ${String(auth.id)}`;
      await sql`DELETE FROM payments     WHERE user_id = ${auth.id}`;
      await sql`DELETE FROM users        WHERE id      = ${auth.id}`;
      return res.json({ ok: true });
    } catch (e) {
      console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." });
    }
  }

  // ── GET /api/user-update?action=invoices → Liste des paiements ──
  if (req.method === "GET" && req.query.action === "invoices") {
    try {
      const PLAN_LABELS = { month: '1 MOIS', quarter: '3 MOIS', year: '12 MOIS' };
      const rows = await sql`
        SELECT id, plan, amount_chf, method, status, created_at
        FROM payments
        WHERE user_id = ${auth.id} AND status = 'success'
        ORDER BY created_at DESC
        LIMIT 24
      `;
      const invoices = rows.map(p => ({
        id: p.id,
        plan: PLAN_LABELS[p.plan] || p.plan,
        amount: parseFloat(p.amount_chf).toFixed(2),
        method: p.method,
        date: new Date(p.created_at).toLocaleDateString('fr-CH', { day: 'numeric', month: 'short', year: 'numeric' }),
      }));
      return res.json({ invoices });
    } catch (e) {
      console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." });
    }
  }


  
  // ── GET /api/user-update?action=check-promo ────────
  if (req.method === "GET" && req.query.action === "check-promo") {
    const code = req.query.code;
    if (!code) return res.status(400).json({ error: "Code manquant." });
    try {
      const cleanCode = code.trim().toUpperCase();
      const [referrer] = await sql`SELECT id FROM users WHERE referral_code = ${cleanCode} AND id != ${auth.id}`;
      if (referrer) {
        return res.json({ ok: true, message: "Code valide ! 1 mois offert." });
      } else {
        return res.status(404).json({ error: "Code invalide." });
      }
    } catch (e) {
      return res.status(500).json({ error: "Erreur serveur." });
    }
  }

  // ── POST /api/user-update?action=claim-referral ────────
  if (req.method === "POST" && req.query.action === "claim-referral") {
    // Rate limit : 1 réclamation par utilisateur par 24h
    const rl = rateLimit(`claim-ref:${auth.id}`, 1, 24 * 60 * 60 * 1000);
    if (!rl.ok) return res.status(429).json({ error: "Tu as déjà réclamé un mois aujourd'hui. Réessaie demain." });

    try {
      const [u] = await sql`SELECT free_months, sub_expires_at, stripe_customer FROM users WHERE id = ${auth.id}`;
      if (!u) return res.status(404).json({ error: "Utilisateur introuvable." });
      if (u.free_months <= 0) return res.status(400).json({ error: "Aucun mois gratuit disponible." });

      // Le mois offert PROLONGE la fin ; la date de début reste celle de la
      // souscription d'origine et n'est jamais réécrite.
      let currentExp = extendPeriodEnd(u.sub_expires_at, 1);

      if (u.stripe_customer) {
        try {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          const subs = await stripe.subscriptions.list({ customer: u.stripe_customer, status: 'active', limit: 1 });
          if (subs.data.length > 0) {
            const subId = subs.data[0].id;
            const currentPeriodEnd = subs.data[0].current_period_end;
            const newTrialEnd = currentPeriodEnd + (30 * 24 * 60 * 60);
            await stripe.subscriptions.update(subId, { trial_end: newTrialEnd, proration_behavior: 'none' });
            currentExp = new Date(newTrialEnd * 1000);
          }
        } catch (stripeErr) {
          console.log("Avertissement Stripe (Paiement TWINT ou erreur):", stripeErr.message);
        }
      }

      const [updatedUser] = await sql`
        UPDATE users 
        SET free_months = free_months - 1, sub_expires_at = ${currentExp}, subscribed = true
        WHERE id = ${auth.id}
        RETURNING free_months, sub_expires_at
      `;

      return res.json({ ok: true, free_months: updatedUser.free_months, sub_expires_at: updatedUser.sub_expires_at });
    } catch (e) {
      console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." });
    }
  }

  return res.status(405).end();
};
