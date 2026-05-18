const cors = require("../lib/cors");
const sql  = require("../lib/db");

const ADMIN_SECRET = process.env.ADMIN_SECRET || "volt-admin-secret-2025";

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.headers["x-admin-secret"] !== ADMIN_SECRET)
    return res.status(401).json({ error: "Non autorisé." });

  try {
    const payments = await sql`
      SELECT p.*, u.first_name, u.last_name
      FROM payments p
      LEFT JOIN users u ON p.user_id = u.id
      ORDER BY p.created_at DESC
      LIMIT 100
    `;

    return res.json({
      payments: payments.map(p => ({
        id:      p.id,
        client:  p.first_name + ' ' + p.last_name,
        plan:    p.plan,
        amount:  parseFloat(p.amount_chf),
        method:  p.method,
        status:  p.status,
        date:    new Date(p.created_at).toLocaleDateString('fr-CH', {day:'numeric',month:'short',year:'numeric'}),
      }))
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
