const cors = require("../lib/cors");
const sql  = require("../lib/db");

const ADMIN_SECRET = process.env.ADMIN_SECRET || "volt-admin-secret-2025";

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.headers["x-admin-secret"] !== ADMIN_SECRET)
    return res.status(401).json({ error: "Non autorisé." });

  try {
    const clients = await sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.plan,
             u.subscribed, u.authorized, u.created_at,
             g.name as gym_name,
             (SELECT COUNT(*) FROM scans s WHERE s.user_id = u.id
              AND s.scanned_at > NOW() - INTERVAL '30 days') as scans,
             (SELECT COALESCE(SUM(p.amount_chf),0) FROM payments p
              WHERE p.user_id = u.id AND p.status = 'success') as revenue
      FROM users u
      LEFT JOIN gyms g ON u.gym_id = g.id
      ORDER BY u.created_at DESC
    `;

    return res.json({
      clients: clients.map(c => ({
        id:         c.id,
        name:       c.first_name + ' ' + c.last_name,
        email:      c.email,
        plan:       c.plan,
        subscribed: c.subscribed,
        authorized: c.authorized,
        gym:        c.gym_name || '—',
        scans:      parseInt(c.scans) || 0,
        revenue:    parseFloat(c.revenue) || 0,
        joined:     new Date(c.created_at).toLocaleDateString('fr-CH', {day:'numeric',month:'short',year:'numeric'}),
      }))
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
