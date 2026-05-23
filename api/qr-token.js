const cors       = require("../lib/cors");
const sql        = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const crypto     = require("crypto");

const QR_TTL = 2 * 60; // 2 minutes en secondes

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  try {
    // Supprime les anciens tokens de cet utilisateur
    await sql`DELETE FROM qr_tokens WHERE user_id = ${String(auth.id)}`;

    // Génère un nouveau token
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
