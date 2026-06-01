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
    // 1 requête : token + user + cooldown via JOIN
    // Cast explicite des deux côtés pour éviter erreur type text/integer
    const [row] = await sql`
      SELECT u.*,
        cd.expires_at AS cd_expires
      FROM qr_tokens qt
      JOIN users u ON u.id::text = qt.user_id::text
      LEFT JOIN cooldowns cd ON cd.user_id = u.id
      WHERE qt.token = ${qr_token}
        AND qt.expires_at > NOW()
    `;

    if (!row)            return res.json({ result: "DENIED", reason: "QR_EXPIRED_OR_INVALID" });
    if (!row.subscribed) return res.json({ result: "DENIED", reason: "NOT_SUBSCRIBED" });
    if (!row.authorized) return res.json({ result: "DENIED", reason: "BLOCKED_BY_GYM" });

    if (row.sub_expires_at && new Date(row.sub_expires_at) < new Date()) {
      sql`UPDATE users SET subscribed = false WHERE id = ${row.id}`.catch(() => {});
      return res.json({ result: "DENIED", reason: "SUB_EXPIRED" });
    }

    const now = new Date();
    if (row.cd_expires && new Date(row.cd_expires) > now)
      return res.json({ result: "COOLDOWN", remaining_secs: Math.ceil((new Date(row.cd_expires) - now) / 1000) });

    // ── Résoudre gym_id depuis machines ────────────────────────────
    let resolvedGymId = null;
    if (machine_id) {
      try {
        const [machine] = await sql`SELECT gym_id FROM machines WHERE machine_id = ${machine_id} AND active = true`;
        resolvedGymId = machine?.gym_id || null;
      } catch(e) { /* machines table not yet created — skip */ }
    }

    // ── Vérifier filiale (skip si non configuré) ────────────────────
    if (resolvedGymId && row.gym_id && row.gym_id !== resolvedGymId) {
      try {
        const [gymMatch] = await sql`
          SELECT 1 FROM gyms g1 JOIN gyms g2 ON g1.filiale = g2.filiale
          WHERE g1.id = ${resolvedGymId} AND g2.id = ${row.gym_id}
        `;
        if (!gymMatch) return res.json({ result: "DENIED", reason: "WRONG_GYM" });
      } catch(e) { /* gyms.filiale not yet added — allow scan */ }
    }

    // ── Écrire en base AVANT de répondre (comportement fiable) ─────
    const exp = new Date(now.getTime() + CD * 1000);
    try {
      await sql`INSERT INTO scans (user_id, gym_id, machine_id) VALUES (${row.id}, ${resolvedGymId}, ${machine_id || null})`;
    } catch(e) {
      try { await sql`INSERT INTO scans (user_id) VALUES (${row.id})`; } catch(e2) {}
    }
    await sql`INSERT INTO cooldowns (user_id, expires_at) VALUES (${row.id}, ${exp}) ON CONFLICT (user_id) DO UPDATE SET expires_at = ${exp}`.catch(() => {});
    await sql`DELETE FROM qr_tokens WHERE token = ${qr_token}`.catch(() => {});

    // ── APPROVED seulement après que tout soit committé ────────────
    return res.json({ result: "APPROVED", user_name: `${row.first_name} ${row.last_name}`, plan: row.plan });

  } catch (e) {
    console.error("validate error:", e);
    return res.status(500).json({ result: "DENIED", reason: "SERVER_ERROR" });
  }
};
