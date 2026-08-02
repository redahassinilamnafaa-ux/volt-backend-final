const cors   = require("../lib/cors");
const sql    = require("../lib/db");

const CD = 15 * 60; // cooldown 15 min en secondes

const APP_VERSION = {
  version_code: 3,
  version_name: "1.2.0",
  apk_url: "",
  release_notes: "Version initiale"
};

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") return res.json(APP_VERSION);
  if (req.method !== "POST") return res.status(405).end();

  const { qr_token, machine_id, gym_id } = req.body || {};
  if (!qr_token) return res.status(400).json({ result: "DENIED", reason: "NO_QR_TOKEN" });

  const providedSecret = req.headers["x-machine-secret"];

  try {
    // ── 1. Vérification Machine & Secret ───────────────────
    let resolvedGymId = gym_id || null;
    let machineValid = false;

    if (machine_id) {
      try {
        const [machine] = await sql`SELECT * FROM machines WHERE machine_id = ${machine_id} AND active = true`;
        if (machine) {
          if (providedSecret === machine.secret || (process.env.MACHINE_SECRET && providedSecret === process.env.MACHINE_SECRET)) {
            machineValid = true;
            resolvedGymId = machine.gym_id || resolvedGymId;
          } else {
            return res.status(401).json({ result: "DENIED", reason: "SECRET_INVALID" });
          }
        }
      } catch(e) { console.error("Machine check error:", e.message); }
    }

    if (!machineValid) {
      const globalSecret = process.env.MACHINE_SECRET;
      if (!globalSecret || providedSecret !== globalSecret) return res.status(401).json({ result: "DENIED", reason: "SECRET_INVALID" });
    }

    // ── 1.5 Une distribution doit etre EN ATTENTE sur cette machine ────────
    // Remplace la garde "anti-gaspillage QR" qui vivait cote app CM30 (elle y
    // testait la reception d'un VEND_REQUEST MDB). Le backend est desormais le
    // seul a connaitre l'etat reel de la borne (la tablette l'y declare via
    // POST /api/vend, action "open"). Sans machine_id (client historique), ce
    // controle est ignore et le comportement reste celui d'avant.
    let pendingVend = null;
    if (machine_id) {
      const [pv] = await sql`
        SELECT order_id, product_name FROM vends
        WHERE machine_id = ${machine_id} AND state = 'PENDING' AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1
      `;
      if (!pv) return res.json({ result: "DENIED", reason: "NO_PENDING_VEND" });
      pendingVend = pv;
    }

    // ── 2. Lecture Token + User + Cooldown ────────────────
    const [row] = await sql`
      SELECT u.*, cd.expires_at AS cd_expires
      FROM qr_tokens qt
      JOIN users u ON u.id::text = qt.user_id::text
      LEFT JOIN cooldowns cd ON cd.user_id::text = u.id::text
      WHERE qt.token = ${qr_token} AND qt.expires_at > NOW()
    `;

    if (!row)            return res.json({ result: "DENIED", reason: "QR_EXPIRED_OR_INVALID" });
    if (!row.subscribed) return res.json({ result: "DENIED", reason: "NOT_SUBSCRIBED" });
    if (!row.authorized) return res.json({ result: "DENIED", reason: "BLOCKED_BY_GYM" });

    if (row.sub_expires_at && new Date(row.sub_expires_at) < new Date()) {
      sql`UPDATE users SET subscribed = false WHERE id = ${row.id}`.catch(() => {});
      return res.json({ result: "DENIED", reason: "SUB_EXPIRED" });
    }

    const now = new Date();
    if (row.cd_expires && new Date(row.cd_expires) > now) {
      return res.json({ result: "COOLDOWN", remaining_secs: Math.ceil((new Date(row.cd_expires) - now) / 1000) });
    }

    // ── 3. Auto-liaison (Premier Scan) & Filiale ──────────
    if (!row.gym_id && resolvedGymId) {
      await sql`UPDATE users SET gym_id = ${resolvedGymId} WHERE id = ${row.id}`;
      row.gym_id = resolvedGymId;
    }

    if (resolvedGymId && row.gym_id) {
      const [match] = await sql`
        SELECT 1 FROM gyms g1, gyms g2
        WHERE g1.id = ${resolvedGymId} AND g2.id = ${row.gym_id}
        AND (g1.filiale = g2.filiale OR g1.id = g2.id)
      `;
      if (!match) return res.json({ result: "DENIED", reason: "WRONG_GYM" });
    }

    const userName = `${row.first_name} ${row.last_name}`;

    // ── 4a. Machine avec distribution en attente : RESERVATION ─────────────
    // Rien n'est debite ici. Le cooldown, l'ecriture dans `scans` et la
    // suppression du token n'interviennent qu'au commit (api/vend.js), une
    // fois la boisson reellement servie.
    if (pendingVend) {
      const updated = await sql`
        UPDATE vends
        SET state = 'AUTHORIZED', user_id = ${String(row.id)}, user_name = ${userName},
            qr_token = ${qr_token}, gym_id = ${resolvedGymId}, updated_at = NOW()
        WHERE order_id = ${pendingVend.order_id} AND state = 'PENDING'
        RETURNING order_id
      `;
      if (!updated.length) {
        // Un autre scan a gagne la course entre la lecture et l'ecriture.
        return res.json({ result: "DENIED", reason: "NO_PENDING_VEND" });
      }
      return res.json({
        result: "APPROVED", user_name: userName, plan: row.plan,
        order_id: pendingVend.order_id, product_name: pendingVend.product_name,
      });
    }

    // ── 4b. Pas de machine_id (client historique) : comportement inchange ──
    const exp = new Date(now.getTime() + CD * 1000);
    try { await sql`INSERT INTO scans (user_id, gym_id, machine_id) VALUES (${row.id}, ${resolvedGymId}, ${machine_id || null})`; } catch(e) {}
    await sql`INSERT INTO cooldowns (user_id, expires_at) VALUES (${row.id}, ${exp}) ON CONFLICT (user_id) DO UPDATE SET expires_at = ${exp}`;
    await sql`DELETE FROM qr_tokens WHERE token = ${qr_token}`;

    return res.json({ result: "APPROVED", user_name: userName, plan: row.plan });

  } catch (e) {
    console.error("validate error:", e);
    return res.status(500).json({ result: "DENIED", reason: "SERVER_ERROR" });
  }
};
