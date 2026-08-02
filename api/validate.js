const cors   = require("../lib/cors");
const sql    = require("../lib/db");

const CD = 15 * 60; // cooldown 15 min en secondes

// Duree de vie d'une distribution en attente de QR (voir vendOpen). Superieure
// au compte a rebours de la tablette (120 s) pour que ce soit toujours ELLE
// qui abandonne la premiere.
const VEND_TTL_SECS = 140;

const APP_VERSION = {
  version_code: 3,
  version_name: "1.2.0",
  apk_url: "",
  release_notes: "Version initiale"
};

/**
 * Authentifie l'appareil appelant : secret propre a la machine (table
 * `machines`) si elle existe et est active, sinon secret global MACHINE_SECRET.
 * Meme logique qu'auparavant, extraite ici car partagee par la validation QR
 * ET le cycle de vie de la distribution ci-dessous — les deux faces du meme
 * rendez-vous borne <-> backend.
 */
async function resolveMachine(req) {
  const { machine_id, gym_id } = req.body || {};
  const providedSecret = req.headers["x-machine-secret"];
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
          return { ok: false };
        }
      }
    } catch (e) { console.error("[validate] machine check error:", e.message); }
  }

  if (!machineValid) {
    const globalSecret = process.env.MACHINE_SECRET;
    if (!globalSecret || providedSecret !== globalSecret) return { ok: false };
  }

  return { ok: true, gymId: resolvedGymId };
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") return res.json(APP_VERSION);
  if (req.method !== "POST") return res.status(405).end();

  const body = req.body || {};

  // ══════════════════════════════════════════════════════════════════════════
  // Cycle de vie d'une distribution (tablette <-> backend), regroupe ICI plutot
  // que dans un fichier /api/vend separe : le plan Hobby de Vercel plafonne a
  // 12 fonctions serverless par deploiement, et ce depot en comptait deja 12
  // sans lui.
  //
  //   tablette  open   -> vends.state = PENDING   ("presentez votre QR")
  //   CM30      scan   -> (plus bas dans ce fichier) reserve -> AUTHORIZED
  //   tablette  status -> sondage
  //   tablette  commit -> DISPENSED (cooldown + token consommes) ou FAILED
  //
  // Remplace l'autorisation MDB (bus serie vers la carte mere de la machine,
  // firmware ferme, sessions fantomes) qui posait probleme sur la borne VOLT.
  // Toutes les actions sont IDEMPOTENTES.
  // ══════════════════════════════════════════════════════════════════════════
  if (["open", "status", "commit", "cancel"].includes(body.action)) {
    const auth = await resolveMachine(req);
    if (!auth.ok) return res.status(401).json({ ok: false, error: "SECRET_INVALID" });
    try {
      switch (body.action) {
        case "open":   return await vendOpen(body, auth, res);
        case "status": return await vendStatus(body, res);
        case "commit": return await vendCommit(body, res);
        case "cancel": return await vendCancel(body, res);
      }
    } catch (e) {
      console.error("[vend]", body.action, e);
      return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Validation du QR presente au lecteur CM30 (comportement existant).
  // ══════════════════════════════════════════════════════════════════════════
  const { qr_token, machine_id } = body;
  if (!qr_token) return res.status(400).json({ result: "DENIED", reason: "NO_QR_TOKEN" });

  const machineAuth = await resolveMachine(req);
  if (!machineAuth.ok) return res.status(401).json({ result: "DENIED", reason: "SECRET_INVALID" });
  const resolvedGymId = machineAuth.gymId;

  try {
    // ── 1. Une distribution doit etre EN ATTENTE sur cette machine ─────────
    // Remplace la garde "anti-gaspillage QR" qui vivait cote app CM30 (elle y
    // testait la reception d'un VEND_REQUEST MDB). Le backend est desormais le
    // seul a connaitre l'etat reel de la borne (la tablette l'y declare via
    // action "open" ci-dessus). Sans machine_id (client historique), ce
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
    // suppression du token n'interviennent qu'au commit (action "commit"
    // ci-dessus), une fois la boisson reellement servie.
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

// ══════════════════════════════════════════════════════════════════════════
//  Cycle de vie de la distribution — handlers
// ══════════════════════════════════════════════════════════════════════════

/**
 * La tablette declare une distribution en attente de QR.
 *
 * Toute distribution encore ouverte sur la MEME machine est abandonnee : il ne
 * peut y avoir qu'un client a la fois devant une borne, et une distribution
 * orpheline (client parti sans scanner) bloquerait toutes les suivantes.
 */
async function vendOpen(body, auth, res) {
  const { machine_id, order_id, product_name, amount_cents } = body;
  if (!machine_id || !order_id)
    return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

  await sql`
    UPDATE vends SET state = 'CANCELLED', updated_at = NOW()
    WHERE machine_id = ${machine_id}
      AND state IN ('PENDING', 'AUTHORIZED')
      AND order_id <> ${order_id}
  `;

  const expires = new Date(Date.now() + VEND_TTL_SECS * 1000);

  // Rejouer un open (reemission apres coupure) ne doit pas ecraser une
  // autorisation deja obtenue : on ne reinitialise que si l'etat est terminal.
  await sql`
    INSERT INTO vends (order_id, machine_id, gym_id, product_name, amount_cents, state, expires_at)
    VALUES (${order_id}, ${machine_id}, ${auth.gymId}, ${product_name || null},
            ${Number(amount_cents) || 0}, 'PENDING', ${expires})
    ON CONFLICT (order_id) DO UPDATE
      SET state      = CASE WHEN vends.state = 'AUTHORIZED' THEN 'AUTHORIZED' ELSE 'PENDING' END,
          expires_at = ${expires},
          updated_at = NOW()
  `;

  return res.json({ ok: true, order_id, state: "PENDING", expires_at: expires.toISOString() });
}

/** Sondage de la tablette (toutes les 5 s) pendant l'attente du scan. */
async function vendStatus(body, res) {
  const { order_id } = body;
  if (!order_id) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

  const [v] = await sql`SELECT * FROM vends WHERE order_id = ${order_id}`;
  if (!v) return res.json({ ok: true, state: "UNKNOWN" });

  // L'expiration est evaluee a la lecture : pas de tache de fond a maintenir.
  const expired = new Date(v.expires_at) < new Date();
  const state = (v.state === "PENDING" || v.state === "AUTHORIZED") && expired ? "EXPIRED" : v.state;

  return res.json({ ok: true, state, user_name: v.user_name || null });
}

/**
 * La tablette confirme le resultat REEL de la distribution.
 *
 * C'est ici — et nulle part avant — que le client est debite de son quart d'heure
 * et que son QR est consomme. Si la machine n'a pas servi, il repart intact.
 * `gym_id` est celui capture a l'autorisation (plus haut dans ce fichier) : les
 * rapports par salle/filiale restent corrects.
 */
async function vendCommit(body, res) {
  const { order_id, success } = body;
  if (!order_id) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

  const [v] = await sql`SELECT * FROM vends WHERE order_id = ${order_id}`;
  if (!v) return res.json({ ok: true, state: "UNKNOWN" });

  // Idempotence : un commit rejoue ne doit ni redebiter ni relever une erreur.
  if (v.state === "DISPENSED" || v.state === "FAILED" || v.state === "CANCELLED")
    return res.json({ ok: true, state: v.state, already: true });

  if (!success) {
    await sql`UPDATE vends SET state = 'FAILED', updated_at = NOW() WHERE order_id = ${order_id}`;
    return res.json({ ok: true, state: "FAILED" });
  }

  if (v.state !== "AUTHORIZED") {
    // Succes annonce sans autorisation prealable : incoherent, on ne debite pas.
    console.warn("[vend] commit success on non-authorized vend:", order_id, v.state);
    await sql`UPDATE vends SET state = 'FAILED', updated_at = NOW() WHERE order_id = ${order_id}`;
    return res.json({ ok: true, state: "FAILED", error: "NOT_AUTHORIZED" });
  }

  const now = new Date();
  const cooldownExp = new Date(now.getTime() + CD * 1000);

  try { await sql`INSERT INTO scans (user_id, gym_id, machine_id) VALUES (${v.user_id}, ${v.gym_id}, ${v.machine_id})`; } catch (e) {}
  await sql`
    INSERT INTO cooldowns (user_id, expires_at) VALUES (${v.user_id}, ${cooldownExp})
    ON CONFLICT (user_id) DO UPDATE SET expires_at = ${cooldownExp}
  `;
  if (v.qr_token) {
    await sql`DELETE FROM qr_tokens WHERE token = ${v.qr_token}`;
  }
  await sql`UPDATE vends SET state = 'DISPENSED', updated_at = NOW() WHERE order_id = ${order_id}`;

  return res.json({ ok: true, state: "DISPENSED", cooldown_secs: CD });
}

/** Retour arriere sur la tablette, ou expiration du compte a rebours. */
async function vendCancel(body, res) {
  const { order_id } = body;
  if (!order_id) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

  await sql`
    UPDATE vends SET state = 'CANCELLED', updated_at = NOW()
    WHERE order_id = ${order_id} AND state IN ('PENDING', 'AUTHORIZED')
  `;
  return res.json({ ok: true, state: "CANCELLED" });
}
