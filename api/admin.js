const cors   = require("../lib/cors");
const sql    = require("../lib/db");
const bcrypt = require("bcryptjs");
const { Resend } = require("resend");
const { signToken, requireAuth } = require("../lib/auth");
const { computeSubscription, computeCustomWindow, daysLeft, parseDayInput, fmtCH } = require("../lib/subscription");
const { ensureSubEventsTable, logSubEvent } = require("../lib/subEvents");
const { ensurePauseColumns, setPause, cancelPause } = require("../lib/subPause");
const { ensurePaymentsSchema } = require("../lib/payments");
const Stripe = require("stripe");

/**
 * Reserve de poudre livree a chaque salle.
 *
 * gym_id en TEXT et non INTEGER : les migrations de ce fichier declarent des
 * entiers, mais elles ne se sont jamais appliquees aux tables deja existantes —
 * en base reelle les identifiants de salle sont du texte. Une premiere version
 * en INTEGER faisait echouer tout enregistrement de stock. Meme correction que
 * celle deja faite sur vends.gym_id.
 */
async function ensureGymStockTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS gym_stock (
      gym_id     TEXT NOT NULL,
      product    TEXT NOT NULL,
      grams      INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (gym_id, product)
    )`;
  // Rattrape une table creee par la version precedente, en INTEGER.
  try { await sql`ALTER TABLE gym_stock ALTER COLUMN gym_id TYPE TEXT USING gym_id::text`; }
  catch (e) { /* deja en TEXT */ }
}
const { isPaused } = require("../lib/subscription");
module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action } = req.query;

  // ── Login admin (pas d'auth requise) ──────────────────
  if (action === "login" && req.method === "POST") {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Champs manquants." });
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminEmail || !adminPassword) return res.status(500).json({ error: "Configuration serveur manquante." });
    if (email.toLowerCase() !== adminEmail.toLowerCase() || password !== adminPassword) {
      return res.status(401).json({ error: "Identifiants incorrects." });
    }
    const token = signToken({ role: "admin", email: adminEmail }, "8h");
    return res.json({ token });
  }

  // ── Cron notify (auth spéciale CRON_SECRET) ───────────
  if (action === "cron-notify" && req.method === "GET") {
    const cronAuth = req.headers.authorization;
    if (process.env.CRON_SECRET && cronAuth !== `Bearer ${process.env.CRON_SECRET}`)
      return res.status(401).json({ error: "Unauthorized" });
    try {
      const rows = await sql`
        SELECT id, first_name, email, sub_expires_at FROM users
        WHERE subscribed = true AND sub_expires_at IS NOT NULL
          AND sub_expires_at > NOW() + INTERVAL '6 days'
          AND sub_expires_at <= NOW() + INTERVAL '7 days'
      `;
      const resend = new Resend(process.env.RESEND_API_KEY);
      let sent = 0;
      for (const u of rows) {
        const expDate = new Date(u.sub_expires_at).toLocaleDateString("fr-CH", { timeZone:"Europe/Zurich", day:"numeric", month:"long", year:"numeric" });
        try {
          await resend.emails.send({ from:"VOLT. <noreply@volt-energy.ch>", to:u.email, subject:"⚠️ Ton abonnement VOLT. expire dans 7 jours", html:`<style>@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@800;900&display=swap');</style><div style="background:#040c22;padding:32px 16px;font-family:Arial,sans-serif"><div style="max-width:460px;margin:0 auto"><div style="background:#071433;border-radius:18px;overflow:hidden"><div style="background:#071433;padding:32px 32px 22px;border-bottom:1px solid rgba(0,87,255,.14)"><div style="font-size:76px;font-weight:900;color:#fff;letter-spacing:-2px;line-height:.9;font-family:'Barlow Condensed','Arial Black',Arial,sans-serif">VOLT.</div><div style="width:44px;height:4px;background:#FF9500;margin-top:14px;border-radius:2px"></div></div><div style="padding:28px 32px 22px"><div style="font-size:20px;font-weight:800;color:#fff;margin-bottom:10px">Ton abonnement expire bientôt ⚠️</div><div style="font-size:14px;color:rgba(255,255,255,.55);line-height:1.8;margin-bottom:24px">Salut <strong style="color:#fff">${u.first_name}</strong>,<br/>Ton abonnement expire le <strong style="color:#fff">${expDate}</strong> (dans <strong style="color:#FF9500">7 jours</strong>).</div><a href="https://volt-energy.ch/VoltApp.html" style="display:block;background:#0057FF;color:#fff;text-align:center;padding:15px 20px;border-radius:12px;font-size:15px;font-weight:900;text-decoration:none">RENOUVELER →</a></div><div style="padding:14px 32px;border-top:1px solid rgba(255,255,255,.05)"><div style="font-size:11px;color:rgba(255,255,255,.18)">VOLT. · Crissier · Switzerland</div></div></div></div></div>` });
          sent++;
        } catch(emailErr) { console.error(`cron-notify ${u.email}:`, emailErr); }
      }
      return res.json({ ok:true, sent, total:rows.length });
    } catch(e) { return res.status(500).json({ error:"Erreur serveur." }); }
  }

  // ── Toutes les autres actions nécessitent un JWT admin ─
  const authData = requireAuth(req);
  if (!authData || authData.role !== "admin") return res.status(401).json({ error: "Non autorisé." });

  // ── stats ──────────────────────────────────────────────
  if (action === "stats") {
    try {
      const [[subs],[users],[gyms],[scans],[rm],[rt],months] = await Promise.all([
        sql`SELECT COUNT(*) as n FROM users WHERE subscribed=true`,
        sql`SELECT COUNT(*) as n FROM users`,
        sql`SELECT COUNT(*) as n FROM gyms`,
        sql`SELECT COUNT(*) as n FROM scans WHERE scanned_at>NOW()-INTERVAL '30 days'`,
        sql`SELECT COALESCE(SUM(amount_chf),0) as n FROM payments WHERE status='success' AND created_at>NOW()-INTERVAL '30 days'`,
        sql`SELECT COALESCE(SUM(amount_chf),0) as n FROM payments WHERE status='success'`,
        // Serie sur 12 mois, boissons ET revenus. generate_series remplit les
        // mois sans activite : sans cela le graphe les sauterait et la
        // comparaison d'un mois a l'autre serait faussee. Heure de Zurich,
        // sinon les scans de fin de mois en soiree basculent sur le mois suivant.
        sql`
          SELECT TO_CHAR(m.d, 'YYYY-MM') AS ym,
                 COALESCE(sc.n, 0)   AS n,
                 COALESCE(pa.rev, 0) AS rev
          FROM generate_series(
                 DATE_TRUNC('month', NOW() AT TIME ZONE 'Europe/Zurich') - INTERVAL '11 months',
                 DATE_TRUNC('month', NOW() AT TIME ZONE 'Europe/Zurich'),
                 INTERVAL '1 month') AS m(d)
          LEFT JOIN (
            SELECT DATE_TRUNC('month', scanned_at AT TIME ZONE 'Europe/Zurich') AS d, COUNT(*) AS n
            FROM scans GROUP BY 1
          ) sc ON sc.d = m.d
          LEFT JOIN (
            SELECT DATE_TRUNC('month', created_at AT TIME ZONE 'Europe/Zurich') AS d, SUM(amount_chf) AS rev
            FROM payments WHERE status = 'success' GROUP BY 1
          ) pa ON pa.d = m.d
          ORDER BY m.d ASC`,
      ]);
      return res.json({ subscribers:parseInt(subs.n), total_users:parseInt(users.n), total_gyms:parseInt(gyms.n), scans_month:parseInt(scans.n), rev_month:parseFloat(rm.n), rev_total:parseFloat(rt.n),
        months: months.map(r => ({ ym: r.ym, n: parseInt(r.n), rev: parseFloat(r.rev) })) });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  // ── clients ────────────────────────────────────────────
  if (action === "clients") {
    try {
      await ensurePauseColumns(sql);
      const rows = await sql`
        SELECT u.id,u.first_name,u.last_name,u.email,u.plan,u.subscribed,u.authorized,u.email_verified,u.created_at,
          u.gym_id,
          u.sub_started_at, u.sub_expires_at, u.sub_paused_from, u.sub_paused_to,
          g.name as gym_name, g.filiale as gym_filiale,
          (SELECT COUNT(*) FROM scans s WHERE s.user_id=u.id AND s.scanned_at>NOW()-INTERVAL '30 days') as scans,
          (SELECT COALESCE(SUM(p.amount_chf),0) FROM payments p WHERE p.user_id=u.id AND p.status='success') as revenue
        FROM users u LEFT JOIN gyms g ON u.gym_id=g.id ORDER BY u.created_at DESC`;
      return res.json({ clients: rows.map(c=>({
        id:c.id,
        name:c.first_name+' '+c.last_name,
        email:c.email,
        plan:c.plan,
        subscribed:c.subscribed,
        authorized:c.authorized,
        email_verified:c.email_verified,
        gym_id:c.gym_id,
        gym:c.gym_name||'—',
        filiale:c.gym_filiale||'',
        scans:parseInt(c.scans)||0,
        revenue:parseFloat(c.revenue)||0,
        joined:new Date(c.created_at).toLocaleDateString('fr-CH',{day:'numeric',month:'short',year:'numeric'}),
        sub_started_at: c.sub_started_at ? new Date(c.sub_started_at).toISOString() : null,
        sub_expires_at: c.sub_expires_at ? new Date(c.sub_expires_at).toISOString() : null,
        sub_start: fmtCH(c.sub_started_at),
        sub_end:   fmtCH(c.sub_expires_at),
        days_left: c.subscribed ? daysLeft(c.sub_expires_at) : null,
        paused_now:    isPaused(c.sub_paused_from, c.sub_paused_to),
        pause_planned: !!(c.sub_paused_from && c.sub_paused_to && new Date(c.sub_paused_to) > new Date()),
        paused_from: c.sub_paused_from ? fmtCH(c.sub_paused_from) : null,
        paused_to:   c.sub_paused_to   ? fmtCH(c.sub_paused_to)   : null
      })) });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  // ── RATTACHER un client a un fitness ───────────────────
  //
  // Sans ce rattachement, les paiements du client sont absents de la
  // Comptabilite, des Virements et du tableau de bord de la salle : ces trois
  // vues joignent payments -> users -> gyms en INNER JOIN. Il n'existait
  // pourtant aucun moyen de le faire depuis l'admin.
  if (action === "client-gym" && req.method === "POST") {
    const { user_id, gym_id } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "user_id requis." });
    try {
      // Rapprochements en ::text : le type des identifiants varie en base
      // (users.id est un uuid la ou les migrations annoncaient un entier), on
      // ne le presume donc jamais. La valeur ecrite reste l'id natif de gyms.
      let target = null;
      if (gym_id) {
        const [g] = await sql`SELECT id FROM gyms WHERE id::text = ${String(gym_id)}`;
        if (!g) return res.status(400).json({ error: "Fitness introuvable." });
        target = g.id;
      }
      const rows = await sql`
        UPDATE users SET gym_id = ${target}
        WHERE id::text = ${String(user_id)}
        RETURNING id`;
      if (!rows.length) return res.status(404).json({ error: "Client introuvable." });
      return res.json({ ok: true });
    } catch(e) {
      console.error("[admin][client-gym]", e);
      return res.status(500).json({ error: "Erreur serveur.", detail: e.message });
    }
  }

  // ── historique d'abonnement d'un client (lisible, chronologique) ──
  if (action === "sub-history" && req.method === "GET") {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error:"user_id requis." });
    try {
      await ensureSubEventsTable(sql);
      // Les paiements sont lus dans la table `payments`, qui fait autorite, et
      // non dans subscription_events : ces evenements-la n'ont longtemps jamais
      // ete ecrits (dans pay-confirm.js, logSubEvent etait appele APRES l'INSERT
      // qui echouait, donc jamais atteint), si bien que l'historique d'un client
      // n'affichait que les actions manuelles. Lire la source garantit que tout
      // paiement encaisse apparait, y compris ceux rattrapes depuis Stripe.
      //
      // Les evenements 'payment'/'renewal' sont donc exclus de subscription_events,
      // sinon les paiements recents y figureraient deux fois.
      const rows = await sql`
        SELECT event_type, source, plan, days, sub_started_at, sub_expires_at, note, created_at
        FROM (
          SELECT event_type, source, plan, days, sub_started_at, sub_expires_at, note, created_at
          FROM subscription_events
          WHERE user_id = ${user_id}
            AND event_type NOT IN ('payment', 'renewal')
          UNION ALL
          SELECT 'payment'::text,
                 (CASE WHEN method = 'twint' THEN 'twint' ELSE 'stripe' END)::text,
                 plan::text,
                 NULL::int,
                 NULL::timestamptz,
                 NULL::timestamptz,
                 ('CHF ' || TO_CHAR(amount_chf, 'FM999990.00')
                          || COALESCE(' — ' || stripe_payment_id, ''))::text,
                 created_at
          FROM payments
          WHERE user_id = ${user_id} AND status = 'success'
        ) h
        ORDER BY created_at DESC
        LIMIT 100`;

      const LABELS = {
        admin_activate: '✅ Activé par l\'admin',
        admin_cancel:   '⛔ Résilié par l\'admin',
        payment:        '💳 Paiement reçu',
        renewal:        '🔄 Renouvelé',
        referral_bonus: '🎁 Mois offert (parrainage)',
        expired:        '⏳ Expiré automatiquement',
        paused:         '⏸️ Abonnement mis en pause',
        pause_cancelled:'▶️ Pause annulée / reprise',
      };
      const PLAN_LABELS = { month:'Mensuel', quarter:'Trimestriel', year:'Annuel', custom:'Jours offerts' };

      return res.json({ events: rows.map(e => ({
        when: new Date(e.created_at).toLocaleString('fr-CH', { timeZone:'Europe/Zurich', day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }),
        label: LABELS[e.event_type] || e.event_type,
        source: e.source,
        plan_label: PLAN_LABELS[e.plan] || e.plan || null,
        window: (e.sub_started_at && e.sub_expires_at)
          ? `${fmtCH(e.sub_started_at)} → ${fmtCH(e.sub_expires_at)}`
          : null,
        days: e.days,
        note: e.note,
      })) });
    } catch(e) { console.error("[admin][sub-history]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  // ── PAUSE d'abonnement (vacances) ──────────────────────
  if (action === "pause" && req.method === "POST") {
    const { user_id, from, to } = req.body||{};
    if (!user_id) return res.status(400).json({ error:"user_id requis." });
    try {
      const r = await setPause(sql, { user_id, from, to, source: 'admin' });
      if (r.error) return res.status(r.status || 400).json({ error: r.error });
      return res.json(r);
    } catch(e) { console.error("[admin][pause]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  if (action === "cancel-pause" && req.method === "POST") {
    const { user_id } = req.body||{};
    if (!user_id) return res.status(400).json({ error:"user_id requis." });
    try {
      const r = await cancelPause(sql, { user_id, source: 'admin' });
      if (r.error) return res.status(r.status || 400).json({ error: r.error });
      return res.json(r);
    } catch(e) { console.error("[admin][cancel-pause]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  if (action === "access" && req.method === "POST") {
    const { user_id, authorized } = req.body||{};
    if (!user_id) return res.status(400).json({ error:"user_id requis." });
    try {
      await sql`UPDATE users SET authorized=${authorized} WHERE id=${user_id}`;
      return res.json({ ok:true });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  // ── subscribe (activer/désactiver manuellement) ────────
  if (action === "subscribe" && req.method === "POST") {
    const { user_id, subscribed, plan, start_date, extend, days } = req.body||{};
    if (!user_id) return res.status(400).json({ error:"user_id requis." });
    try {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_started_at TIMESTAMPTZ`.catch(()=>{});

      if (!subscribed) {
        // On journalise la fenêtre AVANT de l'effacer, sinon l'historique perd l'info.
        const [before] = await sql`SELECT plan, sub_started_at, sub_expires_at FROM users WHERE id=${user_id}`;
        await logSubEvent(sql, {
          user_id, event_type: 'admin_cancel', source: 'admin',
          plan: before?.plan || null,
          sub_started_at: before?.sub_started_at || null,
          sub_expires_at: before?.sub_expires_at || null,
          note: 'Résiliation manuelle par l\'admin — dates effacées.',
        });
        // Résiliation : accès coupé ET dates effacées (l'admin ne veut plus voir
        // de fenêtre "encore valable" pour un abonnement qui n'existe plus).
        await sql`UPDATE users SET subscribed=false, sub_started_at=NULL, sub_expires_at=NULL WHERE id=${user_id}`;
        return res.json({ ok:true });
      }

      let startAt = null;
      if (start_date) {
        startAt = parseDayInput(start_date);
        if (!startAt) return res.status(400).json({ error:"Date de début invalide (format attendu AAAA-MM-JJ)." });
      }

      const [cur] = await sql`SELECT sub_expires_at FROM users WHERE id=${user_id}`;
      if (!cur) return res.status(404).json({ error:"Client introuvable." });

      let dates, chosenPlan;
      if (days) {
        // Durée exacte en jours (ex. 1 jour offert) : prioritaire sur le plan.
        try { dates = computeCustomWindow({ days, startAt }); }
        catch (e) { return res.status(400).json({ error: e.message }); }
        chosenPlan = 'custom';
      } else {
        chosenPlan = plan || 'month';
        try {
          dates = computeSubscription({
            plan: chosenPlan,
            startAt,
            currentExpires: cur.sub_expires_at,
            extend: extend === true && !start_date,   // une date imposée l'emporte sur la prolongation
          });
        } catch { return res.status(400).json({ error:"Plan invalide." }); }
      }

      // Écriture unique et définitive : ces deux dates ne bougeront plus.
      await sql`
        UPDATE users
        SET subscribed = true,
            plan = ${chosenPlan},
            sub_started_at = ${dates.startedAt},
            sub_expires_at = ${dates.expiresAt}
        WHERE id = ${user_id}`;

      await logSubEvent(sql, {
        user_id, event_type: 'admin_activate', source: 'admin',
        plan: chosenPlan, days: dates.days,
        sub_started_at: dates.startedAt, sub_expires_at: dates.expiresAt,
        note: dates.extended ? 'Renouvellement anticipé (prolongation)' : 'Activation manuelle sans paiement.',
      });

      return res.json({
        ok: true,
        plan: chosenPlan,
        extended: dates.extended || false,
        days: dates.days,
        sub_started_at: dates.startedAt.toISOString(),
        sub_expires_at: dates.expiresAt.toISOString(),
        sub_start: fmtCH(dates.startedAt),
        sub_end:   fmtCH(dates.expiresAt),
      });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  // ── payments ───────────────────────────────────────────
  if (action === "payments") {
    try {
      // La salle est rattachee au CLIENT, pas au paiement : c'est elle qui
      // determine a qui reverser. Sans cette colonne, un releve Stripe melangeant
      // plusieurs fitness est impossible a ventiler.
      const rows = await sql`
        SELECT p.*, u.first_name, u.last_name,
               g.name AS gym_name, g.filiale AS gym_filiale
        FROM payments p
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN gyms  g ON u.gym_id  = g.id
        ORDER BY p.created_at DESC LIMIT 100`;
      return res.json({ payments: rows.map(p=>({ id:p.id, client:p.first_name+' '+p.last_name, gym:p.gym_name||'—', filiale:p.gym_filiale||'', plan:p.plan, amount:parseFloat(p.amount_chf), method:p.method, status:p.status, date:new Date(p.created_at).toLocaleDateString('fr-CH',{day:'numeric',month:'short',year:'numeric'}) })) });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  // ── REPRISE des paiements depuis Stripe ────────────────
  //
  // Les paiements encaisses pendant que l'INSERT echouait (index unique
  // manquant, voir lib/payments.js) ne sont RECUPERABLES QUE chez Stripe : la
  // base ne les a jamais vus. Cette action relit les PaymentIntents reussis et
  // reinsere ceux qui manquent, avec leur date d'origine.
  //
  // Sans effet de bord : seuls les paiements absents sont inseres, on peut donc
  // la relancer autant de fois qu'on veut.
  if (action === "sync-payments" && req.method === "POST") {
    try {
      if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: "STRIPE_SECRET_KEY manquante." });
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      await ensurePaymentsSchema(sql);

      let scanned = 0, imported = 0, skipped = 0, pages = 0;
      let startingAfter = req.body?.starting_after || undefined;
      let cursor = null, truncated = false;

      // Garde-fou de duree : une fonction Vercel est tuee net au-dela de sa
      // limite, et le client ne recoit qu'un "Erreur serveur" sans explication.
      // On s'arrete proprement avant, en renvoyant un curseur pour reprendre.
      const deadline = Date.now() + 45_000;

      for (let page = 0; page < 20; page++) {
        if (Date.now() > deadline) { truncated = true; break; }

        const list = await stripe.paymentIntents.list({
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        if (!list.data.length) break;
        pages++;
        scanned += list.data.length;

        const usable = list.data.filter(pi => pi.status === 'succeeded' && pi.amount > 0);
        skipped += list.data.length - usable.length;

        // Un paiement d'abonnement est enregistre par invoice.paid sous
        // l'identifiant de la FACTURE. On reutilise la meme cle ici, sinon la
        // reprise creerait un doublon sous l'identifiant du PaymentIntent.
        const keyOf = pi => (typeof pi.invoice === 'string' ? pi.invoice : pi.invoice?.id) || pi.id;

        // ── 3 requetes par page, et non 2 par paiement ──────────────────────
        // La version initiale interrogeait la base pour CHAQUE paiement : avec
        // Neon en HTTP, chaque requete est un aller-retour reseau, et quelques
        // dizaines de paiements suffisaient a depasser la limite de temps de
        // Vercel — d'ou le "Erreur serveur" au clic sur le bouton.
        const keys = [...new Set(usable.map(keyOf))];
        const already = keys.length
          ? await sql`SELECT stripe_payment_id FROM payments WHERE stripe_payment_id = ANY(${keys})`
          : [];
        const have = new Set(already.map(r => r.stripe_payment_id));

        // Les PaymentIntents d'abonnement portent les metadonnees sur
        // l'abonnement, pas sur eux : on retombe sur le client Stripe.
        const custIds = [...new Set(usable.map(pi => pi.customer).filter(c => typeof c === 'string'))];
        const users = custIds.length
          ? await sql`SELECT id, plan, stripe_customer FROM users WHERE stripe_customer = ANY(${custIds})`
          : [];
        const byCustomer = new Map(users.map(u => [u.stripe_customer, u]));

        const seen = new Set();
        const rows = [];
        for (const pi of usable) {
          const key = keyOf(pi);
          if (have.has(key) || seen.has(key)) { skipped++; continue; }

          // users.id est un uuid : surtout pas de parseInt ici (il renverrait
          // NaN, ou pire un nombre tronque a partir des premiers chiffres).
          const u = typeof pi.customer === 'string' ? byCustomer.get(pi.customer) : null;
          const userId = pi.metadata?.volt_user_id || (u ? u.id : null);
          if (!userId) { skipped++; continue; }

          seen.add(key);
          rows.push({
            userId,
            plan:   pi.metadata?.plan_id || u?.plan || 'unknown',
            amount: pi.amount / 100,
            key,
            method: pi.metadata?.payment_type === 'twint' ? 'twint' : 'card',
            at:     new Date(pi.created * 1000),
          });
        }

        // Insertion groupee : une seule requete pour toute la page.
        //
        // Les identifiants transitent en TEXT et sont rapproches par
        // `u.id::text = x.user_id`, de sorte que la colonne inseree soit
        // toujours `u.id` avec son type natif. On ne code donc en dur ni uuid
        // ni integer : une premiere version castait en ::int[] et echouait avec
        // « column "user_id" is of type uuid but expression is of type integer ».
        // Ce rapprochement garantit en prime qu'on n'insere jamais un paiement
        // rattache a un utilisateur inexistant.
        if (rows.length) {
          const ins = await sql`
            INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status, created_at)
            SELECT u.id, x.plan, x.amount, x.key, x.method, 'success', x.at
            FROM UNNEST(
              ${rows.map(r => String(r.userId))}::text[],
              ${rows.map(r => r.plan)}::text[],
              ${rows.map(r => r.amount)}::numeric[],
              ${rows.map(r => r.key)}::text[],
              ${rows.map(r => r.method)}::text[],
              ${rows.map(r => r.at)}::timestamptz[]
            ) AS x(user_id, plan, amount, key, method, at)
            JOIN users u ON u.id::text = x.user_id
            RETURNING id`;
          imported += ins.length;
        }

        cursor = list.data[list.data.length - 1].id;
        if (!list.has_more) { cursor = null; break; }
        startingAfter = cursor;
      }

      // `next` non nul = il reste des paiements a analyser : relancer l'import
      // le reprendra exactement ou il s'est arrete.
      return res.json({ ok: true, scanned, imported, skipped, pages, truncated, next: truncated ? cursor : null });
    } catch(e) {
      console.error("[admin][sync-payments]", e);
      return res.status(500).json({ error: "Erreur serveur.", detail: e.message });
    }
  }

  // ── gyms GET ───────────────────────────────────────────
  if (action === "gyms" && req.method === "GET") {
    try {
      await sql`ALTER TABLE gyms ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`.catch(()=>{});
      const rows = await sql`
        SELECT g.*,
          (SELECT COUNT(*) FROM users u WHERE u.gym_id=g.id AND u.subscribed=true) as members,
          (SELECT COUNT(*) FROM scans s LEFT JOIN users u ON s.user_id=u.id WHERE u.gym_id=g.id AND s.scanned_at>NOW()-INTERVAL '30 days') as scans,
          (SELECT COALESCE(SUM(p.amount_chf),0) FROM payments p LEFT JOIN users u ON p.user_id=u.id WHERE u.gym_id=g.id AND p.status='success' AND p.created_at>NOW()-INTERVAL '30 days') as revenue
        FROM gyms g ORDER BY g.created_at DESC`;
      return res.json({ gyms: rows.map(g=>({ id:g.id, name:g.name, address:g.address, filiale:g.filiale, email:g.email, active:g.active !== false, members:parseInt(g.members)||0, scans:parseInt(g.scans)||0, revenue:parseFloat(g.revenue)||0 })) });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  // ── gyms POST (créer) ──────────────────────────────────
  if (action === "gyms" && req.method === "POST") {
    const { name, address, filiale, email, password } = req.body||{};
    if (!name||!filiale||!email||!password) return res.status(400).json({ error:"Champs manquants." });
    try {
      const hash = await bcrypt.hash(password, 10);
      const [g] = await sql`INSERT INTO gyms (name,address,filiale,email,password) VALUES (${name},${address||null},${filiale},${email.toLowerCase()},${hash}) RETURNING id,name,filiale,email,address`;
      return res.status(201).json({ ok:true, gym:g });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  // ── gyms PUT (modifier) ────────────────────────────────
  if (action === "gyms" && req.method === "PUT") {
    const { id, name, address, filiale, email, password, active } = req.body||{};
    if (!id) return res.status(400).json({ error:"id requis." });
    try {
      await sql`ALTER TABLE gyms ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`.catch(()=>{});
      // Toggle actif/inactif uniquement
      if (name === undefined && active !== undefined) {
        await sql`UPDATE gyms SET active=${active} WHERE id=${id}`;
        return res.json({ ok:true });
      }
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        await sql`UPDATE gyms SET name=${name},address=${address||null},filiale=${filiale},email=${email.toLowerCase()},password=${hash} WHERE id=${id}`;
      } else {
        await sql`UPDATE gyms SET name=${name},address=${address||null},filiale=${filiale},email=${email.toLowerCase()} WHERE id=${id}`;
      }
      return res.json({ ok:true });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  // ── virements ──────────────────────────────────────────
  if (action === "virements") {
    const ensureVirementTable = async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS virement_status (
          gym_id     INTEGER NOT NULL,
          month_date DATE NOT NULL,
          status     VARCHAR(20) NOT NULL DEFAULT 'paid',
          date_paid  TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (gym_id, month_date)
        )`;
    };

    if (req.method === "GET") {
      try {
        await ensureVirementTable();
        const rows = await sql`
          SELECT g.id as gym_id, g.name as gym_name,
            TO_CHAR(DATE_TRUNC('month',p.created_at),'Mon. YYYY') as month,
            DATE_TRUNC('month',p.created_at) as month_date,
            COALESCE(SUM(p.amount_chf),0) as total_amount,
            COUNT(p.id) as total_payments,
            vs.status as vs_status, vs.date_paid as vs_date_paid
          FROM payments p
          JOIN users u ON p.user_id = u.id
          JOIN gyms g ON u.gym_id = g.id
          LEFT JOIN virement_status vs ON vs.gym_id = g.id AND vs.month_date = DATE_TRUNC('month', p.created_at)
          WHERE p.status = 'success'
          GROUP BY g.id, g.name, DATE_TRUNC('month', p.created_at), vs.status, vs.date_paid
          ORDER BY month_date DESC, g.name`;

        return res.json({ virements: rows.map(r=>({
          id:`${r.gym_id}-${new Date(r.month_date).toISOString().slice(0,10)}`,
          gym_id:r.gym_id, gym_name:r.gym_name, month:r.month,
          count: parseInt(r.total_payments),
          brut: parseFloat(r.total_amount),
          net: parseFloat(r.total_amount),
          status: r.vs_status || 'pending',
          date_paid: r.vs_date_paid ? new Date(r.vs_date_paid).toISOString() : null
        })) });
      } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
    }

    if (req.method === "PUT") {
      const { items, gym_id, month_date, status } = req.body||{};
      try {
        await ensureVirementTable();
        const list = Array.isArray(items) ? items : [{ gym_id, month_date, status }];
        for (const it of list) {
          if (!it.gym_id || !it.month_date) continue;
          const md = String(it.month_date).slice(0,10);
          if (it.status === 'paid') {
            await sql`INSERT INTO virement_status (gym_id, month_date, status, date_paid)
              VALUES (${it.gym_id}, ${md}, 'paid', NOW())
              ON CONFLICT (gym_id, month_date) DO UPDATE SET status='paid', date_paid=NOW()`;
          } else {
            await sql`DELETE FROM virement_status WHERE gym_id=${it.gym_id} AND month_date=${md}`;
          }
        }
        return res.json({ ok:true });
      } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
    }
  }

  // ── db-setup : migrations complètes ──────────────────
  if (action === "db-setup" && req.method === "POST") {
    const steps = [];
    const run = async (label, query) => {
      try { await query; steps.push({ ok: true, step: label }); }
      catch(e) { steps.push({ ok: false, step: label, error: e.message }); }
    };

    await run("create machines", sql`
      CREATE TABLE IF NOT EXISTS machines (
        id         SERIAL PRIMARY KEY,
        machine_id VARCHAR(100),
        name       VARCHAR(255),
        gym_id     INTEGER,
        secret     VARCHAR(255) NOT NULL DEFAULT '',
        active     BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await run("create sequence", sql`CREATE SEQUENCE IF NOT EXISTS machines_id_seq`);
    await run("attach sequence", sql`ALTER TABLE machines ALTER COLUMN id SET DEFAULT nextval('machines_id_seq')`);

    try {
      const res = await sql`SELECT MAX(id) as maxid FROM machines`;
      const nextId = (res[0]?.maxid || 0) + 1;
      await sql`SELECT setval('machines_id_seq', ${nextId}, false)`;
      steps.push({ ok: true, step: "sync sequence" });
    } catch(e) { steps.push({ ok: false, step: "sync sequence", error: e.message }); }

    await run("machines.machine_id", sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS machine_id VARCHAR(100)`);
    await run("machines.name",       sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS name VARCHAR(255)`);
    await run("machines.gym_id",     sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS gym_id INTEGER`);
    await run("machines.secret",     sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS secret VARCHAR(255) DEFAULT ''`);
    await run("machines.active",     sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
    await run("gyms.filiale",        sql`ALTER TABLE gyms ADD COLUMN IF NOT EXISTS filiale VARCHAR(100)`);
    await run("gyms.active",         sql`ALTER TABLE gyms ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
    await run("users.gym_id",        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS gym_id INTEGER`);
    await run("users.authorized",    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS authorized BOOLEAN DEFAULT true`);
    await run("users.sub_started_at", sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_started_at TIMESTAMPTZ`);
    await run("backfill sub_started_at", sql`
      UPDATE users SET sub_started_at = sub_expires_at - (
        CASE plan WHEN 'year' THEN INTERVAL '12 months'
                  WHEN 'quarter' THEN INTERVAL '3 months'
                  ELSE INTERVAL '1 month' END)
      WHERE sub_started_at IS NULL AND sub_expires_at IS NOT NULL`);
    await run("scans.gym_id",        sql`ALTER TABLE scans ADD COLUMN IF NOT EXISTS gym_id INTEGER`);
    await run("scans.machine_id",    sql`ALTER TABLE scans ADD COLUMN IF NOT EXISTS machine_id VARCHAR(100)`);
    // Table payments + index unique sur stripe_payment_id. Son absence faisait
    // echouer toutes les insertions de paiement (voir lib/payments.js).
    await run("payments schema",     ensurePaymentsSchema(sql));

    return res.json({ ok: steps.every(s => s.ok), steps });
  }

  // ── ensure machines table exists ──────────────────────
  const ensureMachinesTable = async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS machines (
        id         SERIAL PRIMARY KEY,
        machine_id VARCHAR(100),
        name       VARCHAR(255),
        gym_id     INTEGER,
        secret     VARCHAR(255) NOT NULL DEFAULT '',
        active     BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    // Ajouter les colonnes manquantes si la table existait déjà sans elles
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS machine_id VARCHAR(100)`.catch(()=>{});
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS name       VARCHAR(255)`.catch(()=>{});
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS gym_id     INTEGER`.catch(()=>{});
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS secret     VARCHAR(255) DEFAULT ''`.catch(()=>{});
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS active     BOOLEAN DEFAULT true`.catch(()=>{});
    // Colonnes scans
    await sql`ALTER TABLE scans ADD COLUMN IF NOT EXISTS machine_id VARCHAR(100)`.catch(()=>{});
    await sql`ALTER TABLE scans ADD COLUMN IF NOT EXISTS gym_id INTEGER`.catch(()=>{});
  };

  // ── machines GET ───────────────────────────────────────
  // ── Stock livre aux fitness ────────────────────────────
  // La reserve baisse d'un sachet chaque fois qu'un bac est recharge sur une
  // borne (api/validate.js, action hopper_refill). Ici on la CONSULTE et on la
  // recharge apres livraison.
  if (action === "stock" && req.method === "GET") {
    try {
      await ensureGymStockTable();
      const rows = await sql`
        SELECT s.gym_id, g.name AS gym_name, s.product, s.grams, s.updated_at
        FROM gym_stock s LEFT JOIN gyms g ON g.id::text = s.gym_id
        ORDER BY g.name, s.product`;
      return res.json({ stock: rows });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur.", detail: e.message }); }
  }

  if (action === "stock" && req.method === "POST") {
    const { gym_id, product, grams } = req.body || {};
    if (!gym_id || !product) return res.status(400).json({ error:"gym_id et product requis." });
    const g = parseInt(grams);
    if (!Number.isFinite(g) || g < 0) return res.status(400).json({ error:"Quantité invalide." });
    try {
      await ensureGymStockTable();
      // Valeur ABSOLUE et non cumulative : on saisit le stock reellement
      // present apres livraison, ce qui permet aussi de corriger un ecart.
      await sql`
        INSERT INTO gym_stock (gym_id, product, grams, updated_at)
        VALUES (${String(gym_id)}, ${product}, ${g}, NOW())
        ON CONFLICT (gym_id, product) DO UPDATE SET grams = ${g}, updated_at = NOW()`;
      return res.json({ ok:true });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur.", detail: e.message }); }
  }

  // ── Valider l'email d'un membre a la main ──────────────
  // Un compte non verifie ne peut PAS generer de QR (api/qr-token.js), meme
  // abonne et a jour de paiement. Sans ce recours, un client qui n'a jamais
  // recu son message de verification reste bloque, alors qu'il a paye.
  if (action === "verify-email" && req.method === "POST") {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "user_id requis." });
    try {
      const rows = await sql`
        UPDATE users SET email_verified = true
        WHERE id = ${user_id} RETURNING id, email`;
      if (!rows.length) return res.status(404).json({ error: "Membre introuvable." });
      return res.json({ ok: true, email: rows[0].email });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur.", detail: e.message }); }
  }

  // ── Distributions echouees ─────────────────────────────
  if (action === "faults" && req.method === "GET") {
    try {
      await sql`ALTER TABLE vends ADD COLUMN IF NOT EXISTS fail_reason TEXT`.catch(()=>{});
      const rows = await sql`
        SELECT v.order_id, v.machine_id, v.product_name, v.user_name,
               v.fail_reason, v.updated_at, g.name AS gym_name
        FROM vends v LEFT JOIN gyms g ON g.id::text = v.gym_id
        WHERE v.state = 'FAILED'
        ORDER BY v.updated_at DESC LIMIT 200`;
      return res.json({ faults: rows });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  // ── Messages laisses par les clients sur les bornes ────
  if (action === "feedback" && req.method === "GET") {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS feedback (
          id         SERIAL PRIMARY KEY,
          machine_id TEXT,
          message    TEXT NOT NULL,
          phone      TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      const rows = await sql`
        SELECT id, machine_id, message, phone, created_at
        FROM feedback ORDER BY created_at DESC LIMIT 200`;
      return res.json({ feedback: rows });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  if (action === "machines" && req.method === "GET") {
    try {
      await ensureMachinesTable();
      // machine_levels est alimentee par la tablette a chaque distribution
      // (api/validate.js). Creee ici aussi car une machine peut n'avoir jamais
      // rien remonte : sans cela le LEFT JOIN echouerait sur une table absente.
      await sql`
        CREATE TABLE IF NOT EXISTS machine_levels (
          machine_id        TEXT PRIMARY KEY,
          water_ml          INTEGER,
          water_capacity_ml INTEGER,
          hoppers           JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`;
      const rows = await sql`
        SELECT m.id, m.machine_id, m.name, m.gym_id, m.secret, m.active,
               g.name as gym_name,
               l.water_ml, l.water_capacity_ml, l.hoppers, l.updated_at as levels_at
        FROM machines m
        LEFT JOIN gyms g ON m.gym_id = g.id
        LEFT JOIN machine_levels l ON l.machine_id = m.machine_id
        ORDER BY m.created_at DESC`;
      return res.json({ machines: rows.map(m=>({
        id: m.id, machine_id: m.machine_id, name: m.name,
        gym_id: m.gym_id, gym_name: m.gym_name || null,
        secret: m.secret, active: m.active,
        // null tant que la borne n'a servi aucune boisson depuis la mise a jour.
        levels: m.levels_at ? {
          water_ml: m.water_ml,
          water_capacity_ml: m.water_capacity_ml,
          hoppers: m.hoppers || [],
          updated_at: m.levels_at
        } : null
      })) });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  // ── machines POST (créer) ──────────────────────────────
  if (action === "machines" && req.method === "POST") {
    const { machine_id, name, gym_id, secret } = req.body||{};
    if (!machine_id||!name) return res.status(400).json({ error:"machine_id et name requis." });
    try {
      await ensureMachinesTable();
      const [m] = await sql`
        INSERT INTO machines (machine_id, name, gym_id, secret)
        VALUES (${machine_id}, ${name}, ${gym_id||null}, ${secret||process.env.MACHINE_SECRET||''})
        RETURNING id, machine_id, name, gym_id, secret`;
      return res.status(201).json({ ok:true, machine:m });
    } catch(e) {
      if (e.code === '23505' || /duplicate|unique/i.test(e.message)) return res.status(409).json({ error:"Ce Machine ID est déjà utilisé." });
      console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." });
    }
  }

  // ── machines PUT (modifier / toggle) ──────────────────
  if (action === "machines" && req.method === "PUT") {
    const { id, machine_id, name, gym_id, secret, active } = req.body||{};
    if (!id) return res.status(400).json({ error:"id requis." });
    try {
      if (machine_id === undefined && name === undefined && active !== undefined) {
        await sql`UPDATE machines SET active=${active} WHERE id=${id}`;
      } else {
        await sql`UPDATE machines SET machine_id=${machine_id}, name=${name}, gym_id=${gym_id||null}, secret=${secret} WHERE id=${id}`;
      }
      return res.json({ ok:true });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  // ── machines DELETE ────────────────────────────────────
  if (action === "machines" && req.method === "DELETE") {
    const { id } = req.body||{};
    if (!id) return res.status(400).json({ error:"id requis." });
    try {
      await sql`DELETE FROM machines WHERE id=${id}`;
      return res.json({ ok:true });
    } catch(e) { console.error("[admin]", e); return res.status(500).json({ error:"Erreur serveur." }); }
  }

  return res.status(400).json({ error:"Action inconnue." });
};

// L'import Stripe peut demander plusieurs secondes : sans cela Vercel coupe la
// fonction a 10s et le client ne recoit qu'un "Erreur serveur" inexplicable.
module.exports.config = { maxDuration: 60 };
