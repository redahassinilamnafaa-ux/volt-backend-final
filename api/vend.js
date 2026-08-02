const cors = require("../lib/cors");
const sql  = require("../lib/db");

// ══════════════════════════════════════════════════════════════════════════════
// VOLT — Cycle de vie d'une distribution, cote borne.
//
// Point de rendez-vous entre la TABLETTE (qui pilote la machine) et le LECTEUR
// CM30 (qui scanne le QR, cote validate.js). Remplace l'autorisation MDB, qui
// transitait par le firmware ferme de la carte mere et se desynchronisait.
//
//   tablette  --open-->    PENDING      "presentez votre QR"
//   CM30      --validate-> AUTHORIZED   QR valide et RESERVE (validate.js)
//   tablette  --status-->  (sondage toutes les 5 s)
//   tablette  --commit-->  DISPENSED    cooldown applique, token consomme
//                       ou FAILED       reservation liberee, client non penalise
//
// Toutes les actions sont IDEMPOTENTES : la tablette peut rejouer un commit apres
// une coupure reseau sans double comptage.
// ══════════════════════════════════════════════════════════════════════════════

// Duree de vie d'une distribution en attente. Superieure au compte a rebours de
// la tablette (120 s) pour que ce soit toujours ELLE qui abandonne la premiere.
const VEND_TTL_SECS = 140;

// Cooldown applique APRES distribution reelle (identique a celui de validate.js).
const COOLDOWN_SECS = 15 * 60;

/**
 * Authentifie l'appareil appelant, EXACTEMENT comme validate.js : secret propre
 * a la machine (table `machines`) si elle existe et est active, sinon secret
 * global `MACHINE_SECRET`. Meme comportement de repli si `machine_id` n'est pas
 * (encore) enregistre dans l'admin — la borne ne doit pas se retrouver bloquee
 * tant que personne n'a cree sa fiche machine.
 */
async function resolveMachine(req) {
  const { machine_id } = req.body || {};
  const providedSecret = req.headers["x-machine-secret"];
  let gymId = null;
  let machineValid = false;

  if (machine_id) {
    try {
      const [machine] = await sql`SELECT * FROM machines WHERE machine_id = ${machine_id} AND active = true`;
      if (machine) {
        if (providedSecret === machine.secret || (process.env.MACHINE_SECRET && providedSecret === process.env.MACHINE_SECRET)) {
          machineValid = true;
          gymId = machine.gym_id || null;
        } else {
          return { ok: false };
        }
      }
    } catch (e) { console.error("[vend] machine check error:", e.message); }
  }

  if (!machineValid) {
    const globalSecret = process.env.MACHINE_SECRET;
    if (!globalSecret || providedSecret !== globalSecret) return { ok: false };
  }

  return { ok: true, gymId };
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const auth = await resolveMachine(req);
  if (!auth.ok) return res.status(401).json({ ok: false, error: "SECRET_INVALID" });

  const body = req.body || {};
  const action = String(body.action || "");

  try {
    switch (action) {
      case "open":   return await open(body, auth, res);
      case "status": return await status(body, res);
      case "commit": return await commit(body, res);
      case "cancel": return await cancel(body, res);
      default:
        return res.status(400).json({ ok: false, error: "UNKNOWN_ACTION" });
    }
  } catch (e) {
    console.error("[vend]", action, e);
    return res.status(500).json({ ok: false, error: "SERVER_ERROR" });
  }
};

/**
 * La tablette declare une distribution en attente de QR.
 *
 * Toute distribution encore ouverte sur la MEME machine est abandonnee : il ne
 * peut y avoir qu'un client a la fois devant une borne, et une distribution
 * orpheline (client parti sans scanner) bloquerait toutes les suivantes.
 */
async function open(body, auth, res) {
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
async function status(body, res) {
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
 * `gym_id` est celui capture par validate.js a l'autorisation : les rapports par
 * salle/filiale restent corrects meme si la resolution machine->gym change entre
 * temps.
 */
async function commit(body, res) {
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
  const cooldownExp = new Date(now.getTime() + COOLDOWN_SECS * 1000);

  try { await sql`INSERT INTO scans (user_id, gym_id, machine_id) VALUES (${v.user_id}, ${v.gym_id}, ${v.machine_id})`; } catch (e) {}
  await sql`
    INSERT INTO cooldowns (user_id, expires_at) VALUES (${v.user_id}, ${cooldownExp})
    ON CONFLICT (user_id) DO UPDATE SET expires_at = ${cooldownExp}
  `;
  if (v.qr_token) {
    await sql`DELETE FROM qr_tokens WHERE token = ${v.qr_token}`;
  }
  await sql`UPDATE vends SET state = 'DISPENSED', updated_at = NOW() WHERE order_id = ${order_id}`;

  return res.json({ ok: true, state: "DISPENSED", cooldown_secs: COOLDOWN_SECS });
}

/** Retour arriere sur la tablette, ou expiration du compte a rebours. */
async function cancel(body, res) {
  const { order_id } = body;
  if (!order_id) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

  await sql`
    UPDATE vends SET state = 'CANCELLED', updated_at = NOW()
    WHERE order_id = ${order_id} AND state IN ('PENDING', 'AUTHORIZED')
  `;
  return res.json({ ok: true, state: "CANCELLED" });
}
