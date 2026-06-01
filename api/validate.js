const cors   = require("../lib/cors");
const sql    = require("../lib/db");

const CD = 15 * 60; // cooldown 15 min en secondes

// Version de l'APK CM30 — mettre à jour à chaque nouvelle release
const APP_VERSION = {
  version_code: 3,
  version_name: "1.2.0",
  apk_url: "",
  release_notes: "Version initiale"
};

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const machineSecret = req.headers["x-machine-secret"];
  if (machineSecret !== process.env.MACHINE_SECRET)
    return res.status(401).json({ result: "DENIED", reason: "SECRET_INVALID" });

  // ── GET /api/validate?action=version — vérification version APK ──
  if (req.method === "GET") {
    return res.json(APP_VERSION);
  }

  if (req.method !== "POST") return res.status(405).end();

  const { qr_token, machine_id } = req.body || {};
  if (!qr_token)
    return res.status(400).json({ result: "DENIED", reason: "NO_QR_TOKEN" });

  try {
    const tokens = await sql`
      SELECT * FROM qr_tokens
      WHERE token = ${qr_token}
      AND expires_at > NOW()
    `;

    if (!tokens.length)
      return res.json({ result: "DENIED", reason: "QR_EXPIRED_OR_INVALID" });

    const user_id = tokens[0].user_id;

    const [u] = await sql`SELECT * FROM users WHERE id::text = ${String(user_id)}`;
    if (!u)            return res.json({ result: "DENIED", reason: "USER_NOT_FOUND" });
    if (!u.subscribed) return res.json({ result: "DENIED", reason: "NOT_SUBSCRIBED" });
    if (!u.authorized) return res.json({ result: "DENIED", reason: "BLOCKED_BY_GYM" });

    if (u.sub_expires_at && new Date(u.sub_expires_at) < new Date()) {
      sql`UPDATE users SET subscribed = false WHERE id = ${u.id}`.catch(() => {});
      return res.json({ result: "DENIED", reason: "SUB_EXPIRED" });
    }

    const now = new Date();
    const [cd] = await sql`SELECT expires_at FROM cooldowns WHERE user_id = ${u.id}`;
    if (cd && new Date(cd.expires_at) > now)
      return res.json({ result: "COOLDOWN", remaining_secs: Math.ceil((new Date(cd.expires_at) - now) / 1000) });

    // Résoudre gym_id depuis la table machines (skip si table absente)
    let resolvedGymId = null;
    if (machine_id) {
      try {
        const [machine] = await sql`SELECT gym_id FROM machines WHERE machine_id = ${machine_id} AND active = true`;
        resolvedGymId = machine?.gym_id || null;
      } catch(e) { /* machines table not yet created — skip */ }
    }

    // Vérifier filiale (skip si table/colonne absente)
    if (resolvedGymId && u.gym_id && u.gym_id !== resolvedGymId) {
      try {
        const [gymMatch] = await sql`
          SELECT 1 FROM gyms g1 JOIN gyms g2 ON g1.filiale = g2.filiale
          WHERE g1.id = ${resolvedGymId} AND g2.id = ${u.gym_id}
        `;
        if (!gymMatch) return res.json({ result: "DENIED", reason: "WRONG_GYM" });
      } catch(e) { /* gyms.filiale not yet added — allow scan */ }
    }

    // ── Répondre APPROVED immédiatement pour éviter le timeout CM30 ──
    res.json({ result: "APPROVED", user_name: `${u.first_name} ${u.last_name}`, plan: u.plan });

    // ── Enregistrer scan + cooldown + supprimer token APRÈS la réponse ──
    const exp = new Date(now.getTime() + CD * 1000);
    try {
      await sql`INSERT INTO scans (user_id, gym_id, machine_id) VALUES (${u.id}, ${resolvedGymId}, ${machine_id || null})`;
    } catch(e) {
      try {
        await sql`INSERT INTO scans (user_id) VALUES (${u.id})`;
      } catch(e2) {}
    }
    await sql`INSERT INTO cooldowns (user_id, expires_at) VALUES (${u.id}, ${exp}) ON CONFLICT (user_id) DO UPDATE SET expires_at = ${exp}`.catch(() => {});
    await sql`DELETE FROM qr_tokens WHERE token = ${qr_token}`.catch(() => {});

  } catch (e) {
    console.error("validate error:", e);
    return res.status(500).json({ result: "DENIED", reason: "SERVER_ERROR" });
  }
};
