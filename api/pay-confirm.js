const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const DUR = { month: 1, quarter: 3, year: 12 };
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();
  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });
  const { pi, plan_id } = req.body || {};
  if (!pi || !plan_id) return res.status(400).json({ error: "Paramètres manquants." });
  const months = DUR[plan_id];
  if (!months) return res.status(400).json({ error: "Plan invalide." });
  try {
    const exp = new Date(); exp.setMonth(exp.getMonth() + months);
    await sql`UPDATE users SET subscribed = true, plan = ${plan_id}, sub_expires_at = ${exp} WHERE id = ${auth.id}`;
    const [u] = await sql`SELECT referred_by FROM users WHERE id = ${auth.id}`;
    if (u?.referred_by)
      await sql`UPDATE users SET free_months = free_months + 1 WHERE id = ${u.referred_by}`;
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Erreur serveur." });
  }
};
