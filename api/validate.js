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

  // ── GET /api/validate?action=version — vérification version APK ──
  if (req.method === "GET") {
    return res.json(APP_VERSION);
  }

  if (req.method !== "POST") return res.status(405).end();

  const { qr_token, machine_id, gym_id } = req.body || {};
  if (!qr_token)
    return res.status(400).json({ result: "DENIED", reason: "NO_QR_TOKEN" });

  const providedSecret = req.headers["x-machine-secret"];

  try {
    // ── 1. Vérification Machine & Secret Spécifique ────────────────
    let resolvedGymId = gym_id || null;
    let machineValid = false;

    if (machine_id) {
      try {
        const [machine] = await sql`SELECT * FROM machines WHERE machine_id = ${machine_id} AND active = true`;
        if (machine) {
          // Vérifier le secret de la machine OU le secret global (compatibilité)
          if (providedSecret === machine.secret || providedSecret === process.env.MACHINE_SECRET || providedSecret === "volt-admin-secret-2025") {
            machineValid = true;
            resolvedGymId = machine.gym_id || resolvedGymId;
          } else {
            console.log("DENIED SECRET_INVALID for machine=" + machine_id);
            return res.status(401).json({ result: "DENIED", reason: "SECRET_INVALID" });
          }
        }
      } catch(e) {
        console.error("Machine check error (table missing?):", e.message);
      }
    }

    // Si machine non trouvée ou non spécifiée, on exige au moins le secret global
    if (!machineValid) {
      const globalSecret = process.env.MACHINE_SECRET || "volt-admin-secret-2025";
      if (providedSecret !== globalSecret) {
        console.log("DENIED SECRET_INVALID global");
        return res.status(401).json({ result: "DENIED", reason: "SECRET_INVALID" });
      }
    }

    // ── 2. Lecture : token + user + cooldown ───────────
    const [row] = await sql`
      SELECT u.*, cd.expires_at AS cd_expires
      FROM qr_tokens qt
      JOIN users u ON u.id::text = qt.user_id::text
      LEFT JOIN cooldowns cd ON cd.user_id::text = u.id::text
      WHERE qt.token = ${qr_token}
        AND qt.expires_at > NOW()
    `;

    if (!row)            { console.log("DENIED QR_EXPIRED"); return res.json({ result: "DENIED", reason: "QR_EXPIRED_OR_INVALID" }); }
    if (!row.subscribed) { console.log("DENIED NOT_SUBSCRIBED user="+row.id); return res.json({ result: "DENIED", reason: "NOT_SUBSCRIBED" }); }
    if (!row.authorized) { console.log("DENIED BLOCKED user="+row.id); return res.json({ result: "DENIED", reason: "BLOCKED_BY_GYM" }); }

    if (row.sub_expires_at && new Date(row.sub_expires_at) < new Date()) {
      sql`UPDATE users SET subscribed = false WHERE id = ${row.id}`.catch(() => {});
      console.log("DENIED SUB_EXPIRED user="+row.id);
      return res.json({ result: "DENIED", reason: "SUB_EXPIRED" });
    }

    const now = new Date();
    if (row.cd_expires && new Date(row.cd_expires) > now) {
      const secs = Math.ceil((new Date(row.cd_expires) - now) / 1000);
      console.log("COOLDOWN user="+row.id+" remaining="+secs+"s");
      return res.json({ result: "COOLDOWN", remaining_secs: secs });
    }

    // ── 3. Vérification de l'accès par Filiale ───────────────
    // Si l'utilisateur n'est pas encore lié à un fitness, on le lie au fitness de cette machine (Auto-binding)
    if (!row.gym_id && resolvedGymId) {
      await sql`UPDATE users SET gym_id = ${resolvedGymId} WHERE id = ${row.id}`;
      row.gym_id = resolvedGymId;
      console.log(`AUTO-BIND: user ${row.id} linked to gym ${resolvedGymId}`);
    }

    // Si la machine est liée à un fitness, on vérifie que c'est la même filiale que l'utilisateur
    if (resolvedGymId && row.gym_id) {
      const [match] = await sql`
        SELECT 1 FROM gyms g1, gyms g2
        WHERE g1.id = ${resolvedGymId}
        AND g2.id = ${row.gym_id}
        AND (g1.filiale = g2.filiale OR g1.id = g2.id)
      `;

      if (!match) {
        console.log(`DENIED WRONG_FILIALE: user_gym=${row.gym_id} machine_gym=${resolvedGymId}`);
        return res.json({ result: "DENIED", reason: "WRONG_GYM" });
      }
    }
    const exp = new Date(now.getTime() + CD * 1000);
    try {
      await sql`INSERT INTO scans (user_id, gym_id, machine_id) VALUES (${row.id}, ${resolvedGymId}, ${machine_id || null})`;
    } catch(e) {
      try { await sql`INSERT INTO scans (user_id) VALUES (${row.id})`; } catch(e2) {}
    }
    await sql`INSERT INTO cooldowns (user_id, expires_at) VALUES (${row.id}, ${exp}) ON CONFLICT (user_id) DO UPDATE SET expires_at = ${exp}`;
    await sql`DELETE FROM qr_tokens WHERE token = ${qr_token}`;

    // ── 4. SUCCESS ──
    console.log("APPROVED user="+row.id+" plan="+row.plan);
    return res.json({ result: "APPROVED", user_name: `${row.first_name} ${row.last_name}`, plan: row.plan });

  } catch (e) {
    console.error("validate error:", e);
    return res.status(500).json({ result: "DENIED", reason: "SERVER_ERROR" });
  }
};
