const cors = require("../lib/cors");
const sql  = require("../lib/db");

const ADMIN_SECRET = process.env.ADMIN_SECRET || "volt-admin-secret-2025";

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.headers["x-admin-secret"] !== ADMIN_SECRET)
    return res.status(401).json({ error: "Non autorisé." });

  // GET — revenus par fitness par mois
  if (req.method === "GET") {
    try {
      const rows = await sql`
        SELECT
          g.id as gym_id,
          g.name as gym_name,
          TO_CHAR(DATE_TRUNC('month', p.created_at), 'Mon. YYYY') as month,
          DATE_TRUNC('month', p.created_at) as month_date,
          COALESCE(SUM(p.amount_chf), 0) as total
        FROM payments p
        LEFT JOIN users u ON p.user_id = u.id
        LEFT JOIN gyms g ON u.gym_id = g.id
        WHERE p.status = 'success' AND g.id IS NOT NULL
        GROUP BY g.id, g.name, DATE_TRUNC('month', p.created_at)
        ORDER BY month_date DESC, g.name
      `;

      return res.json({
        virements: rows.map((r, i) => ({
          id:        `v${i+1}`,
          gym_id:    r.gym_id,
          gym_name:  r.gym_name,
          month:     r.month,
          brut:      parseFloat(r.total),
          net:       parseFloat(r.total),
          status:    'pending',
          date_paid: null,
        }))
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).end();
};
