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
    // 1 seule requête : user + cooldown en parallèle via LEFT JOIN
    const [row] = await sql`
      SELECT u.email_verified, cd.expires_at AS cd_expires
      FROM users u
      LEFT JOIN cooldowns cd ON cd.user_id = u.id
      WHERE u.id = ${auth.id}
    `;
    if (!row) return res.status(404).json({ error: "Utilisateur introuvable." });
    if (!row.email_verified)
      return res.status(403).json({ error: "Vérifie ton email avant de générer un QR code.", code: "EMAIL_NOT_VERIFIED" });

    const now = new Date();

    // Toujours générer un token (même pendant cooldown)
    // → le CM30 reçoit COOLDOWN (pas QR_EXPIRED) quand il scanne pendant l'attente
    const token  = crypto.randomBytes(24).toString("hex");
    const expiry = new Date(Date.now() + QR_TTL * 1000);

    await sql`
      WITH del AS (DELETE FROM qr_tokens WHERE user_id = ${String(auth.id)})
      INSERT INTO qr_tokens (user_id, token, expires_at)
      VALUES (${String(auth.id)}, ${token}, ${expiry})
    `;

    const result = { token, expires_at: expiry.toISOString(), ttl: QR_TTL };
    if (row.cd_expires && new Date(row.cd_expires) > now) {
      result.cooldown_remaining = Math.ceil((new Date(row.cd_expires) - now) / 1000);
    }
    return res.json(result);

  } catch (e) {
    console.error("qr-token error:", e);
    return res.status(500).json({ error: "Erreur: " + e.message });
  }
};
