const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();
  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });
  const { user_id, authorized } = req.body || {};
  if (!user_id) return res.status(400).json({ error: "user_id requis." });
  try {
    await sql`UPDATE users SET authorized = ${authorized} WHERE id = ${user_id}`;
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Erreur serveur." });
  }
};
