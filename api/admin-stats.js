const cors = require("../lib/cors");
const sql  = require("../lib/db");

const ADMIN_SECRET = process.env.ADMIN_SECRET || "volt-admin-secret-2025";

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.headers["x-admin-secret"] !== ADMIN_SECRET)
    return res.status(401).json({ error: "Non autorisé." });

  try {
    const [subscribers] = await sql`SELECT COUNT(*) as n FROM users WHERE subscribed = true`;
    const [total_users] = await sql`SELECT COUNT(*) as n FROM users`;
    const [total_gyms]  = await sql`SELECT COUNT(*) as n FROM gyms`;
    const [scans_month] = await sql`SELECT COUNT(*) as n FROM scans WHERE scanned_at > NOW() - INTERVAL '30 days'`;
    const [rev_month]   = await sql`SELECT COALESCE(SUM(amount_chf),0) as n FROM payments WHERE status='success' AND created_at > NOW() - INTERVAL '30 days'`;
    const [rev_total]   = await sql`SELECT COALESCE(SUM(amount_chf),0) as n FROM payments WHERE status='success'`;

    return res.json({
      subscribers:  parseInt(subscribers.n),
      total_users:  parseInt(total_users.n),
      total_gyms:   parseInt(total_gyms.n),
      scans_month:  parseInt(scans_month.n),
      rev_month:    parseFloat(rev_month.n),
      rev_total:    parseFloat(rev_total.n),
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
