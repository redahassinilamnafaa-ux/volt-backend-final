const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const Stripe          = require("stripe");
const { Resend }      = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  // ── GET /api/user-update?action=me → Profil utilisateur ────────
  if (req.method === "GET" && req.query.action === "me") {
    try {
      const [u] = await sql`
        SELECT u.*, g.name AS gym_name,
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
          initials: (u.first_name[0] + u.last_name[0]).toUpperCase(),
          plan: u.plan, subscribed: u.subscribed, authorized: u.authorized,
          gym: u.gym_name || null, gym_id: u.gym_id,
          referral_code: u.referral_code,
          referral_count: parseInt(u.ref_count) || 0,
          free_months: u.free_months,
          email_verified: u.email_verified,
          sub_expires_at: u.sub_expires_at ? new Date(u.sub_expires_at).toISOString() : null,
        }
      });
    } catch (e) {
      return res.status(500).json({ error: "Erreur: " + e.message });
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
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const history = rows.map(s => {
        const d = new Date(s.scanned_at);
        const isToday = d >= todayStart;
        const isYest  = d >= new Date(todayStart - 86400000) && !isToday;
        const hm = d.toLocaleTimeString("fr-CH", { hour: "2-digit", minute: "2-digit" });
        const timeStr = isToday ? `Auj. ${hm}` : isYest ? `Hier ${hm}`
          : `${d.toLocaleDateString("fr-CH", { day: "numeric", month: "short" })} ${hm}`;
        return { gym: s.gym_name || "Fitness VOLT", time: timeStr, today: isToday };
      });
      return res.json({ history });
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
      return res.status(500).json({ error: "Erreur: " + e.message });
    }
  }

  // ── GET /api/user-update?action=invoices → Liste des factures ───
  if (req.method === "GET" && req.query.action === "invoices") {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const [u] = await sql`SELECT stripe_customer, email, first_name FROM users WHERE id = ${auth.id}`;
      if (!u || !u.stripe_customer) return res.json({ invoices: [] });

      const stripeInvoices = await stripe.invoices.list({
        customer: u.stripe_customer,
        limit: 24,
        status: "paid",
      });

      const invoices = stripeInvoices.data.map(inv => ({
        id: inv.id,
        number: inv.number,
        amount: (inv.amount_paid / 100).toFixed(2),
        date: new Date(inv.created * 1000).toLocaleDateString("fr-CH"),
        pdf_url: inv.invoice_pdf,
        hosted_url: inv.hosted_invoice_url,
      }));

      return res.json({ invoices });
    } catch (e) {
      return res.status(500).json({ error: "Erreur: " + e.message });
    }
  }

  // ── POST /api/user-update?action=invoices → Envoie facture email ─
  if (req.method === "POST" && req.query.action === "invoices") {
    const { invoice_id } = req.body || {};
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const [u] = await sql`SELECT stripe_customer, email, first_name FROM users WHERE id = ${auth.id}`;
      if (!u || !u.stripe_customer)
        return res.status(400).json({ error: "Aucun abonnement trouvé." });

      let invoice;
      if (invoice_id) {
        invoice = await stripe.invoices.retrieve(invoice_id);
      } else {
        const list = await stripe.invoices.list({ customer: u.stripe_customer, limit: 1, status: "paid" });
        invoice = list.data[0];
      }

      if (!invoice) return res.status(404).json({ error: "Aucune facture trouvée." });

      const amount  = (invoice.amount_paid / 100).toFixed(2);
      const date    = new Date(invoice.created * 1000).toLocaleDateString("fr-CH");
      const pdfUrl  = invoice.invoice_pdf;
      const hosted  = invoice.hosted_invoice_url;

      await resend.emails.send({
        from: "VOLT. <noreply@volt-energy.ch>",
        to: u.email,
        subject: `🧾 Ta facture VOLT. — CHF ${amount}`,
        html: `<div style="background:#060D2E;padding:40px 20px;font-family:Arial,sans-serif"><div style="max-width:480px;margin:0 auto;border-radius:24px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5)"><div style="background:linear-gradient(135deg,#060D2E 0%,#0A1A5C 40%,#0D2280 70%,#1a3aaa 100%);padding:40px 36px 36px"><div style="font-size:64px;font-weight:900;color:#ffffff;letter-spacing:-3px;line-height:1;font-family:Arial Black,Arial,sans-serif">VOLT.</div></div><div style="background:#0f1729;padding:32px 36px"><div style="font-size:22px;font-weight:800;color:#fff;margin-bottom:20px">Ta facture 🧾</div><div style="font-size:15px;color:rgba(255,255,255,0.6);line-height:1.7;margin-bottom:24px">Salut <strong style="color:#fff">${u.first_name}</strong>,<br/>Voici ta facture VOLT. du <strong style="color:#fff">${date}</strong>.</div><div style="background:rgba(255,255,255,.05);border-radius:16px;padding:20px 24px;margin-bottom:24px;border:1px solid rgba(255,255,255,.08)"><div style="font-size:32px;font-weight:900;color:#fff">CHF ${amount}</div><div style="font-size:13px;color:rgba(255,255,255,.4)">${invoice.number || invoice.id}</div></div><a href="${hosted || pdfUrl}" style="display:block;background:linear-gradient(135deg,#003FCC,#0057FF);color:#fff;text-align:center;padding:16px 24px;border-radius:50px;font-size:18px;font-weight:900;text-decoration:none;margin-bottom:12px">VOIR MA FACTURE →</a>${pdfUrl ? '<a href="'+pdfUrl+'" style="display:block;background:rgba(255,255,255,.06);color:rgba(255,255,255,.6);text-align:center;padding:14px 24px;border-radius:50px;font-size:15px;font-weight:700;text-decoration:none;border:1px solid rgba(255,255,255,.1)">Télécharger PDF ↓</a>' : ''}</div><div style="background:#080e1f;padding:18px 36px 24px;border-top:1px solid rgba(255,255,255,0.06)"><div style="font-size:12px;color:rgba(255,255,255,0.2)">VOLT. Energy · Crissier · Switzerland</div></div></div></div>`
      });

      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: "Erreur: " + e.message });
    }
  }


  // ── POST /api/user-update?action=claim-referral ────────
  if (req.method === "POST" && req.query.action === "claim-referral") {
    try {
      const [u] = await sql`SELECT free_months, sub_expires_at, stripe_customer FROM users WHERE id = ${auth.id}`;
      if (!u) return res.status(404).json({ error: "Utilisateur introuvable." });
      if (u.free_months <= 0) return res.status(400).json({ error: "Aucun mois gratuit disponible." });

      let currentExp = u.sub_expires_at ? new Date(u.sub_expires_at) : new Date();
      if (currentExp < new Date()) {
        currentExp = new Date();
      }
      currentExp.setMonth(currentExp.getMonth() + 1);

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
      return res.status(500).json({ error: "Erreur serveur : " + e.message });
    }
  }

  return res.status(405).end();
};
