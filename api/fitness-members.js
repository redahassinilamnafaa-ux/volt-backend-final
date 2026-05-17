const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });
  const { gym_id } = req.query;
  if (!gym_id) return res.status(400).json({ error: "gym_id requis." });
  try {
    const rows = await sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.plan, u.subscribed, u.authorized,
        COUNT(s.id) AS scan_count
      FROM users u
      LEFT JOIN scans s ON s.user_id = u.id AND s.scanned_at > NOW() - INTERVAL '30 days'
      WHERE u.gym_id = ${gym_id}
      GROUP BY u.id ORDER BY u.created_at DESC
    `;
    return res.json({ members: rows.map(m => ({ id: m.id, name: `${m.first_name} ${m.last_name}`, initials: (m.first_name[0] + m.last_name[0]).toUpperCase(), email: m.email, plan: m.plan, subscribed: m.subscribed, authorized: m.authorized, scans: parseInt(m.scan_count) || 0 })) });
  } catch (e) {
    return res.status(500).json({ error: "Erreur serveur." });
  }
};
