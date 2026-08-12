const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth, signToken } = require("../lib/auth");
const bcrypt          = require("bcryptjs");
const { daysLeft, fmtCH, computeSubscription, computeCustomWindow, parseDayInput } = require("../lib/subscription");
const { ensureSubEventsTable, logSubEvent } = require("../lib/subEvents");
const { ensurePauseColumns, setPause, cancelPause } = require("../lib/subPause");
const { isPaused } = require("../lib/subscription");

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const { action } = req.query;

  // ── LOGIN gérant fitness ───────────────────────────────
  if (action === "login" && req.method === "POST") {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "Champs manquants." });
    try {
      const [g] = await sql`SELECT id, name, filiale, email, address, password FROM gyms WHERE email = ${email.toLowerCase()}`;
      if (!g) return res.status(401).json({ error: "Email ou mot de passe incorrect." });
      const ok = await bcrypt.compare(password, g.password);
      if (!ok) return res.status(401).json({ error: "Email ou mot de passe incorrect." });
      const token = signToken({ id: g.id, email: g.email, role: "gym" });
      return res.json({ token, gym: { id: g.id, name: g.name, filiale: g.filiale, email: g.email, address: g.address } });
    } catch(e) { console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  // Auth requise pour les autres routes
  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });
  if (auth.role !== "gym") return res.status(403).json({ error: "Accès réservé aux gérants." });

  const gym_id = auth.id;

  // ── STATS du fitness ───────────────────────────────────
  if (action === "stats") {
    try {
      const [[members],[total],[scansM],[scansT],[revM],[revT]] = await Promise.all([
        sql`SELECT COUNT(*) as n FROM users WHERE gym_id=${gym_id} AND subscribed=true`,
        sql`SELECT COUNT(*) as n FROM users WHERE gym_id=${gym_id}`,
        sql`SELECT COUNT(*) as n FROM scans s JOIN users u ON s.user_id=u.id WHERE u.gym_id=${gym_id} AND s.scanned_at>NOW()-INTERVAL '30 days'`,
        sql`SELECT COUNT(*) as n FROM scans s JOIN users u ON s.user_id=u.id WHERE u.gym_id=${gym_id}`,
        sql`SELECT COALESCE(SUM(p.amount_chf),0) as n FROM payments p JOIN users u ON p.user_id=u.id WHERE u.gym_id=${gym_id} AND p.status='success' AND p.created_at>NOW()-INTERVAL '30 days'`,
        sql`SELECT COALESCE(SUM(p.amount_chf),0) as n FROM payments p JOIN users u ON p.user_id=u.id WHERE u.gym_id=${gym_id} AND p.status='success'`,
      ]);
      // Stocks des bornes de CETTE salle. Requete separee et tolerante : le
      // tableau de bord doit continuer a s'afficher meme si aucune borne n'a
      // encore rien remonte, ou si les tables n'existent pas sur une base
      // ancienne. Alimente par la tablette (api/validate.js, action commit).
      // Ces tables ne naissent qu'a la premiere distribution / au premier
      // message. Sans cette creation prealable, la requete echouait sur une
      // table absente, l'erreur etait avalee, et le tableau de bord restait
      // desesperement vide tant qu'aucune boisson n'avait ete servie.
      try {
        await sql`
          CREATE TABLE IF NOT EXISTS machine_levels (
            machine_id        TEXT PRIMARY KEY,
            water_ml          INTEGER,
            water_capacity_ml INTEGER,
            hoppers           JSONB NOT NULL DEFAULT '[]'::jsonb,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await sql`
          CREATE TABLE IF NOT EXISTS feedback (
            id         SERIAL PRIMARY KEY,
            machine_id TEXT,
            message    TEXT NOT NULL,
            phone      TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        // TEXT : en base reelle les identifiants de salle sont du texte, malgre
        // les migrations qui declarent des entiers.
        await sql`ALTER TABLE feedback ADD COLUMN IF NOT EXISTS gym_id TEXT`;
        await sql`ALTER TABLE vends ADD COLUMN IF NOT EXISTS fail_reason TEXT`;
      } catch (e) {
        console.warn("[fitness] preparation des tables:", e.message);
      }

      let machines = [];
      try {
        machines = await sql`
          SELECT m.machine_id, m.name,
                 l.water_ml, l.water_capacity_ml, l.hoppers, l.updated_at
          FROM machines m
          LEFT JOIN machine_levels l ON l.machine_id = m.machine_id
          WHERE m.gym_id::text = ${String(gym_id)} AND m.active = true
          ORDER BY m.name`;
      } catch (e) {
        console.warn("[fitness] stocks indisponibles:", e.message);
      }

      // Messages clients et pannes des bornes de CETTE salle. Requetes
      // separees et tolerantes : le tableau de bord doit s'afficher meme si ces
      // tables n'existent pas encore sur une base ancienne.
      let feedback = [], faults = [];
      try {
        feedback = await sql`
          SELECT id, machine_id, message, phone, created_at
          FROM feedback WHERE gym_id::text = ${String(gym_id)}
          ORDER BY created_at DESC LIMIT 50`;
      } catch (e) { console.warn("[fitness] messages indisponibles:", e.message); }
      try {
        faults = await sql`
          SELECT order_id, machine_id, product_name, fail_reason, updated_at
          FROM vends WHERE gym_id::text = ${String(gym_id)} AND state = 'FAILED'
          ORDER BY updated_at DESC LIMIT 50`;
      } catch (e) { console.warn("[fitness] pannes indisponibles:", e.message); }

      return res.json({
        feedback,
        faults,
        members_active: parseInt(members.n) || 0,
        members_total:  parseInt(total.n)   || 0,
        scans_month:    parseInt(scansM.n)  || 0,
        scans_total:    parseInt(scansT.n)  || 0,
        rev_month:      parseFloat(revM.n)  || 0,
        rev_total:      parseFloat(revT.n)  || 0,
        machines: machines.map(m => ({
          machine_id: m.machine_id,
          name: m.name,
          levels: m.updated_at ? {
            water_ml: m.water_ml,
            water_capacity_ml: m.water_capacity_ml,
            hoppers: m.hoppers || [],
            updated_at: m.updated_at,
          } : null,
        })),
      });
    } catch(e) { console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  // ── MEMBRES du fitness ─────────────────────────────────
  if (action === "members") {
    try {
      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_started_at TIMESTAMPTZ`.catch(()=>{});
      await ensurePauseColumns(sql);
      const rows = await sql`
        SELECT u.id, u.first_name, u.last_name, u.email, u.plan, u.subscribed, u.authorized, u.created_at,
          u.sub_started_at, u.sub_expires_at, u.sub_paused_from, u.sub_paused_to,
          (SELECT COUNT(*) FROM scans s WHERE s.user_id=u.id AND s.scanned_at>NOW()-INTERVAL '30 days') as scans_month,
          (SELECT COUNT(*) FROM scans s WHERE s.user_id=u.id) as scans_total,
          (SELECT COALESCE(SUM(p.amount_chf),0) FROM payments p WHERE p.user_id=u.id AND p.status='success') as revenue
        FROM users u
        WHERE u.gym_id = ${gym_id}
        ORDER BY u.created_at DESC
      `;
      return res.json({ members: rows.map(m => ({
        id: m.id,
        name: m.first_name + ' ' + m.last_name,
        initials: ((m.first_name||'?')[0] + (m.last_name||'?')[0]).toUpperCase(),
        email: m.email,
        plan: m.plan,
        subscribed: m.subscribed,
        authorized: m.authorized,
        scans_month: parseInt(m.scans_month) || 0,
        scans_total: parseInt(m.scans_total) || 0,
        revenue: parseFloat(m.revenue) || 0,
        joined: new Date(m.created_at).toLocaleDateString('fr-CH', { day:'numeric', month:'short', year:'numeric' }),
        sub_started_at: m.sub_started_at ? new Date(m.sub_started_at).toISOString() : null,
        sub_expires_at: m.sub_expires_at ? new Date(m.sub_expires_at).toISOString() : null,
        sub_start: fmtCH(m.sub_started_at),
        sub_end:   fmtCH(m.sub_expires_at),
        days_left: m.subscribed ? daysLeft(m.sub_expires_at) : null,
        paused_now:    isPaused(m.sub_paused_from, m.sub_paused_to),
        pause_planned: !!(m.sub_paused_from && m.sub_paused_to && new Date(m.sub_paused_to) > new Date()),
        paused_from: m.sub_paused_from ? fmtCH(m.sub_paused_from) : null,
        paused_to:   m.sub_paused_to   ? fmtCH(m.sub_paused_to)   : null,
      })) });
    } catch(e) { console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  // ── SCANS par jour (30 derniers jours) + par mois (12 mois) ────
  if (action === "scans") {
    try {
      const [rows, months] = await Promise.all([
        sql`
          SELECT DATE(s.scanned_at) as day, COUNT(*) as n
          FROM scans s JOIN users u ON s.user_id=u.id
          WHERE u.gym_id=${gym_id} AND s.scanned_at>NOW()-INTERVAL '30 days'
          GROUP BY DATE(s.scanned_at) ORDER BY day ASC
        `,
        // generate_series remplit les mois sans aucune distribution : sans cela
        // le graphe sauterait ces mois et fausserait la comparaison visuelle.
        // Heure de Zurich, comme partout ailleurs dans le projet.
        sql`
          SELECT TO_CHAR(m.d, 'YYYY-MM') AS ym, COALESCE(x.n, 0) AS n
          FROM generate_series(
                 DATE_TRUNC('month', NOW() AT TIME ZONE 'Europe/Zurich') - INTERVAL '11 months',
                 DATE_TRUNC('month', NOW() AT TIME ZONE 'Europe/Zurich'),
                 INTERVAL '1 month') AS m(d)
          LEFT JOIN (
            SELECT DATE_TRUNC('month', s.scanned_at AT TIME ZONE 'Europe/Zurich') AS d,
                   COUNT(*) AS n
            FROM scans s JOIN users u ON s.user_id = u.id
            WHERE u.gym_id = ${gym_id}
            GROUP BY 1
          ) x ON x.d = m.d
          ORDER BY m.d ASC
        `,
      ]);
      return res.json({
        scans:  rows.map(r => ({ day: r.day, n: parseInt(r.n) })),
        months: months.map(r => ({ ym: r.ym, n: parseInt(r.n) })),
      });
    } catch(e) { console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  // ── CONSOMMATION mensuelle d'UN membre (12 mois) ───────
  if (action === "member-scans" && req.method === "GET") {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: "user_id requis." });
    try {
      // Le gerant ne consulte que ses propres membres.
      const [u] = await sql`SELECT id FROM users WHERE id::text=${String(user_id)} AND gym_id=${gym_id}`;
      if (!u) return res.status(403).json({ error: "Membre non trouvé dans votre fitness." });

      const months = await sql`
        SELECT TO_CHAR(m.d, 'YYYY-MM') AS ym, COALESCE(x.n, 0) AS n
        FROM generate_series(
               DATE_TRUNC('month', NOW() AT TIME ZONE 'Europe/Zurich') - INTERVAL '11 months',
               DATE_TRUNC('month', NOW() AT TIME ZONE 'Europe/Zurich'),
               INTERVAL '1 month') AS m(d)
        LEFT JOIN (
          SELECT DATE_TRUNC('month', s.scanned_at AT TIME ZONE 'Europe/Zurich') AS d,
                 COUNT(*) AS n
          FROM scans s
          WHERE s.user_id::text = ${String(user_id)}
          GROUP BY 1
        ) x ON x.d = m.d
        ORDER BY m.d ASC`;

      return res.json({ months: months.map(r => ({ ym: r.ym, n: parseInt(r.n) })) });
    } catch(e) { console.error("[api][member-scans]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  // ── VIREMENTS reçus ────────────────────────────────────
  if (action === "virements") {
    try {
      const rows = await sql`
        SELECT
          TO_CHAR(DATE_TRUNC('month', p.created_at), 'Mon. YYYY') as month,
          DATE_TRUNC('month', p.created_at) as month_date,
          COALESCE(SUM(p.amount_chf), 0) as total,
          COUNT(*) as nb_payments
        FROM payments p
        JOIN users u ON p.user_id = u.id
        WHERE u.gym_id = ${gym_id} AND p.status = 'success'
        GROUP BY DATE_TRUNC('month', p.created_at)
        ORDER BY month_date DESC
      `;
      return res.json({ virements: rows.map(r => ({
        month: r.month,
        total: parseFloat(r.total) || 0,
        nb_payments: parseInt(r.nb_payments) || 0,
        status: 'paid',
      })) });
    } catch(e) { console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  // ── AUTORISER / BLOQUER un membre ─────────────────────
  if (action === "access" && req.method === "POST") {
    const { user_id, authorized } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "user_id requis." });
    try {
      // Vérifie que le membre appartient bien à ce fitness
      const [u] = await sql`SELECT id FROM users WHERE id=${user_id} AND gym_id=${gym_id}`;
      if (!u) return res.status(403).json({ error: "Membre non trouvé dans votre fitness." });
      await sql`UPDATE users SET authorized=${authorized} WHERE id=${user_id}`;
      return res.json({ ok: true });
    } catch(e) { console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  // ── ABONNEMENT (activation manuelle / résiliation) ─────
  if (action === "subscribe" && req.method === "POST") {
    const { user_id, subscribed, plan, start_date, extend, days } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "user_id requis." });
    try {
      // Le gérant ne peut agir que sur ses propres membres.
      const [u] = await sql`SELECT id, plan, sub_started_at, sub_expires_at FROM users WHERE id=${user_id} AND gym_id=${gym_id}`;
      if (!u) return res.status(403).json({ error: "Membre non trouvé dans votre fitness." });

      await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_started_at TIMESTAMPTZ`.catch(()=>{});

      if (!subscribed) {
        // On journalise la fenêtre AVANT de l'effacer.
        await logSubEvent(sql, {
          user_id, event_type: 'admin_cancel', source: 'gym',
          plan: u.plan || null,
          sub_started_at: u.sub_started_at || null,
          sub_expires_at: u.sub_expires_at || null,
          note: 'Résiliation par le fitness — dates effacées.',
        });
        await sql`UPDATE users SET subscribed=false, sub_started_at=NULL, sub_expires_at=NULL WHERE id=${user_id}`;
        return res.json({ ok: true });
      }

      let startAt = null;
      if (start_date) {
        startAt = parseDayInput(start_date);
        if (!startAt) return res.status(400).json({ error: "Date de début invalide (format attendu AAAA-MM-JJ)." });
      }

      let dates, chosenPlan;
      if (days) {
        try { dates = computeCustomWindow({ days, startAt }); }
        catch (e) { return res.status(400).json({ error: e.message }); }
        chosenPlan = 'custom';
      } else {
        chosenPlan = plan || 'month';
        try {
          dates = computeSubscription({
            plan: chosenPlan,
            startAt,
            currentExpires: u.sub_expires_at,
            extend: extend === true && !start_date,
          });
        } catch { return res.status(400).json({ error: "Plan invalide." }); }
      }

      await sql`
        UPDATE users
        SET subscribed = true,
            plan = ${chosenPlan},
            sub_started_at = ${dates.startedAt},
            sub_expires_at = ${dates.expiresAt}
        WHERE id = ${user_id}`;

      await logSubEvent(sql, {
        user_id, event_type: 'admin_activate', source: 'gym',
        plan: chosenPlan, days: dates.days,
        sub_started_at: dates.startedAt, sub_expires_at: dates.expiresAt,
        note: dates.extended ? 'Renouvellement anticipé (prolongation) par le fitness.' : 'Activation manuelle par le fitness, sans paiement.',
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
    } catch(e) { console.error("[api][fitness-subscribe]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  // ── HISTORIQUE d'abonnement d'un membre ────────────────
  if (action === "sub-history" && req.method === "GET") {
    const { user_id } = req.query;
    if (!user_id) return res.status(400).json({ error: "user_id requis." });
    try {
      const [u] = await sql`SELECT id FROM users WHERE id=${user_id} AND gym_id=${gym_id}`;
      if (!u) return res.status(403).json({ error: "Membre non trouvé dans votre fitness." });

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
        admin_activate: '✅ Abonnement activé',
        admin_cancel:   '⛔ Abonnement résilié',
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
    } catch(e) { console.error("[api][fitness-sub-history]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  // ── PAUSE d'abonnement (vacances) ──────────────────────
  if (action === "pause" && req.method === "POST") {
    const { user_id, from, to } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "user_id requis." });
    try {
      const [u] = await sql`SELECT id FROM users WHERE id=${user_id} AND gym_id=${gym_id}`;
      if (!u) return res.status(403).json({ error: "Membre non trouvé dans votre fitness." });
      const r = await setPause(sql, { user_id, from, to, source: 'gym' });
      if (r.error) return res.status(r.status || 400).json({ error: r.error });
      return res.json(r);
    } catch(e) { console.error("[api][fitness-pause]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  if (action === "cancel-pause" && req.method === "POST") {
    const { user_id } = req.body || {};
    if (!user_id) return res.status(400).json({ error: "user_id requis." });
    try {
      const [u] = await sql`SELECT id FROM users WHERE id=${user_id} AND gym_id=${gym_id}`;
      if (!u) return res.status(403).json({ error: "Membre non trouvé dans votre fitness." });
      const r = await cancelPause(sql, { user_id, source: 'gym' });
      if (r.error) return res.status(r.status || 400).json({ error: r.error });
      return res.json(r);
    } catch(e) { console.error("[api][fitness-cancel-pause]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  return res.status(400).json({ error: "Action inconnue." });
};
