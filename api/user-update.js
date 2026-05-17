const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();
  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });
  const { firstName, lastName, email, phone } = req.body || {};
  try {
    await sql`UPDATE users SET first_name = ${firstName}, last_name = ${lastName}, email = ${email.toLowerCase()}, phone = ${phone || null} WHERE id = ${auth.id}`;
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Erreur serveur." });
  }
};
