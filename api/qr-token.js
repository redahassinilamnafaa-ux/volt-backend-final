const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const crypto          = require("crypto");

const QR_TTL = 5 * 60; // 5 minutes

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  try {
    const [u] = await sql`
      SELECT email_verified FROM users WHERE id = ${auth.id}
    `;
    if (!u) return res.status(404).json({ error: "Utilisateur introuvable." });
    if (!u.email_verified)
      return res.status(403).json({ error: "Vérifie ton email avant de générer un QR code.", code: "EMAIL_NOT_VERIFIED" });

    await sql`DELETE FROM qr_tokens WHERE user_id = ${String(auth.id)}`;

    const token = crypto.randomBytes(24).toString("hex");
    const expiry = new Date(Date.now() + QR_TTL * 1000);

    await sql`
      INSERT INTO qr_tokens (user_id, token, expires_at)
      VALUES (${String(auth.id)}, ${token}, ${expiry})
    `;

    return res.json({
      token,
      expires_at: expiry.toISOString(),
      ttl: QR_TTL,
    });

  } catch (e) {
    console.error("qr-token error:", e);
    return res.status(500).json({ error: "Erreur: " + e.message });
  }
};
