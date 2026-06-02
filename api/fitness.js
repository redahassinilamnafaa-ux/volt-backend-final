const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth, signToken } = require("../lib/auth");
const bcrypt          = require("bcryptjs");

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
      return res.json({
        members_active: parseInt(members.n) || 0,
        members_total:  parseInt(total.n)   || 0,
        scans_month:    parseInt(scansM.n)  || 0,
        scans_total:    parseInt(scansT.n)  || 0,
        rev_month:      parseFloat(revM.n)  || 0,
        rev_total:      parseFloat(revT.n)  || 0,
      });
    } catch(e) { console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  // ── MEMBRES du fitness ─────────────────────────────────
  if (action === "members") {
    try {
      const rows = await sql`
        SELECT u.id, u.first_name, u.last_name, u.email, u.plan, u.subscribed, u.authorized, u.created_at,
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
      })) });
    } catch(e) { console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  // ── SCANS par jour (30 derniers jours) ─────────────────
  if (action === "scans") {
    try {
      const rows = await sql`
        SELECT DATE(s.scanned_at) as day, COUNT(*) as n
        FROM scans s JOIN users u ON s.user_id=u.id
        WHERE u.gym_id=${gym_id} AND s.scanned_at>NOW()-INTERVAL '30 days'
        GROUP BY DATE(s.scanned_at) ORDER BY day ASC
      `;
      return res.json({ scans: rows.map(r => ({ day: r.day, n: parseInt(r.n) })) });
    } catch(e) { console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." }); }
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

  return res.status(400).json({ error: "Action inconnue." });
};
