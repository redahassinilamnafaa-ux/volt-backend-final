const cors   = require("../lib/cors");
const sql    = require("../lib/db");
const { isPaused } = require("../lib/subscription");

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
  if (["open", "status", "commit", "cancel", "hopper_refill", "feedback"].includes(body.action)) {
    const auth = await resolveMachine(req);
    if (!auth.ok) return res.status(401).json({ ok: false, error: "SECRET_INVALID" });
    try {
      switch (body.action) {
        case "open":   return await vendOpen(body, auth, res);
        case "status": return await vendStatus(body, res);
        case "commit": return await vendCommit(body, res);
        case "cancel": return await vendCancel(body, res);
        case "hopper_refill": return await hopperRefill(body, res);
        case "feedback": return await clientFeedback(body, res);
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

    // Abonnement gelé (vacances) : accès suspendu, mais les jours sont rendus à la fin.
    if (isPaused(row.sub_paused_from, row.sub_paused_to)) {
      return res.json({ result: "DENIED", reason: "SUB_PAUSED" });
    }

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
    // Le COOLDOWN et l'ecriture dans `scans` n'interviennent qu'au commit
    // (action "commit" ci-dessus), une fois la boisson reellement servie : un
    // echec machine ne coute rien au client.
    //
    // Le TOKEN QR, en revanche, est supprime ICI, des l'autorisation, PAS au
    // commit. Ce sont deux choses distinctes : sans cette suppression
    // immediate, le meme token restait valide pendant toute la duree de la
    // distribution (jusqu'a 30s) et pouvait etre represente — capture d'ecran,
    // ou meme telephone repose devant une AUTRE borne — pour autoriser une
    // deuxieme distribution avant que la premiere ne soit confirmee. Un QR a
    // usage unique doit rester a usage unique meme si la machine echoue
    // ensuite a servir ; dans ce cas le client garde son credit (pas de
    // cooldown) mais doit reafficher un QR frais depuis son app pour
    // reessayer — comportement volontaire, pas un oubli.
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
      await sql`DELETE FROM qr_tokens WHERE token = ${qr_token}`;
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
 * Etat des stocks de la borne (bidon d'eau, bacs de poudre).
 *
 * Cree a la volee, comme `machines` dans api/admin.js : le depot n'a pas de
 * lanceur de migrations, et cette convention evite une manipulation SQL manuelle
 * dans Neon a chaque deploiement.
 */
async function ensureLevelsTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS machine_levels (
      machine_id        TEXT PRIMARY KEY,
      water_ml          INTEGER,
      water_capacity_ml INTEGER,
      hoppers           JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
}

/**
 * Enregistre les niveaux transmis par la tablette avec la confirmation de
 * distribution — le seul moment ou ils changent.
 *
 * TOUTE erreur est avalee : cette ecriture est accessoire, alors que le commit
 * qui l'entoure est le chemin qui debite le client. Perdre une remontee de stock
 * est sans consequence ; faire echouer un commit en ferait une.
 */
/** Seuils appliques par la tablette — a garder identiques a VoltWaterTank. */
const WATER_WARN_ML = 4000;
const WATER_BLOCK_ML = 2000;

/**
 * Alerte l'exploitant au FRANCHISSEMENT d'un seuil, jamais en dessous.
 *
 * Comparer l'ancien et le nouveau niveau evite le harcelement : une fois la
 * borne bloquee, les distributions suivantes restent sous le seuil et ne
 * renvoient donc rien. Le remplissage rearme l'alerte.
 *
 * Erreurs avalees : une alerte perdue est moins grave qu'un commit echoue.
 */
async function alertOnThreshold(machine_id, previous, levels) {
  const before = previous && Number.isFinite(previous.water_ml) ? previous.water_ml : null;
  const after = Number.isFinite(levels.water_ml) ? levels.water_ml : null;
  if (after === null) return;

  // Sans historique, on n'alerte que si l'etat est deja critique.
  const crossed = (limit) => before === null ? after <= limit : (before > limit && after <= limit);

  let subject = null;
  let detail = null;
  if (crossed(WATER_BLOCK_ML)) {
    subject = `⛔ VOLT ${machine_id} — machine à l'arrêt, plus d'eau`;
    detail = `La borne <strong>${machine_id}</strong> a cessé de servir : il reste ${(after / 1000).toFixed(1)} L.
      <br/><br/>Ce blocage est volontaire — il empêche la pompe de tourner à vide et de griller.
      <br/><br/><strong>À faire :</strong> remplir le bidon À RAS, puis confirmer sur l'écran de la machine
      (Administration → Inventaire → « Réservoir rempli »). Sans cette confirmation la borne reste bloquée.`;
  } else if (crossed(WATER_WARN_ML)) {
    subject = `⚠️ VOLT ${machine_id} — bidon bas`;
    detail = `Il reste ${(after / 1000).toFixed(1)} L dans la borne <strong>${machine_id}</strong>,
      soit une dizaine de boissons. Prévoyez un remplissage : en dessous de
      ${(WATER_BLOCK_ML / 1000).toFixed(1)} L la borne s'arrête de servir.`;
  }

  // Bacs passes sous leur seuil depuis la derniere remontee.
  const prevHoppers = Array.isArray(previous?.hoppers) ? previous.hoppers : [];
  const nowHoppers = Array.isArray(levels.hoppers) ? levels.hoppers : [];
  const newlyLow = nowHoppers.filter((h) => {
    if (!(h.warn_g > 0) || !(h.grams <= h.warn_g)) return false;
    const p = prevHoppers.find((x) => x.id === h.id);
    return !p || p.grams > h.warn_g;
  });
  if (newlyLow.length) {
    const list = newlyLow.map((h) => `${h.name || h.id} (${h.grams} g)`).join(", ");
    subject = subject || `⚠️ VOLT ${machine_id} — poudre à recharger`;
    detail = (detail ? detail + "<br/><br/>" : "") + `<strong>Bacs à recharger :</strong> ${list}.`;
  }

  if (!subject) return;
  await sendAlertEmail(subject, detail);
}

async function recordLevels(machine_id, levels) {
  if (!machine_id || !levels || typeof levels !== "object") return;
  try {
    await ensureLevelsTable();
    const water = Number.isFinite(levels.water_ml) ? levels.water_ml : null;
    const capacity = Number.isFinite(levels.water_capacity_ml) ? levels.water_capacity_ml : null;
    const hoppers = JSON.stringify(Array.isArray(levels.hoppers) ? levels.hoppers : []);

    // Etat precedent lu AVANT l'ecriture : c'est lui qui distingue un
    // franchissement de seuil d'un simple passage sous le seuil.
    const [previous] = await sql`
      SELECT water_ml, hoppers FROM machine_levels WHERE machine_id = ${machine_id}`;
    await alertOnThreshold(machine_id, previous, levels);

    await sql`
      INSERT INTO machine_levels (machine_id, water_ml, water_capacity_ml, hoppers, updated_at)
      VALUES (${machine_id}, ${water}, ${capacity}, ${hoppers}::jsonb, NOW())
      ON CONFLICT (machine_id) DO UPDATE SET
        water_ml          = EXCLUDED.water_ml,
        water_capacity_ml = EXCLUDED.water_capacity_ml,
        hoppers           = EXCLUDED.hoppers,
        updated_at        = NOW()
    `;
  } catch (e) {
    console.warn("[levels] enregistrement impossible:", e.message);
  }
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
  const { order_id, success, machine_id, levels } = body;
  if (!order_id) return res.status(400).json({ ok: false, error: "MISSING_FIELDS" });

  // Avant toute sortie : les niveaux valent aussi pour une distribution ratee,
  // et plusieurs branches ci-dessous retournent tot.
  await recordLevels(machine_id, levels);

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
  // Filet defensif : le token est deja supprime au moment du scan (voir plus
  // haut dans ce fichier, action de validation QR). Ce DELETE ne trouve donc
  // normalement plus rien — conserve au cas ou un futur chemin marquerait un
  // vend AUTHORIZED sans passer par ce code.
  if (v.qr_token) {
    await sql`DELETE FROM qr_tokens WHERE token = ${v.qr_token}`;
  }
  await sql`UPDATE vends SET state = 'DISPENSED', updated_at = NOW() WHERE order_id = ${order_id}`;

  return res.json({ ok: true, state: "DISPENSED", cooldown_secs: CD });
}

/** Reserve restante en deca de laquelle une livraison doit etre planifiee. */
const STOCK_ALERT_G = 1000;

async function ensureGymStockTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS gym_stock (
      gym_id     INTEGER NOT NULL,
      product    TEXT NOT NULL,
      grams      INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (gym_id, product)
    )`;
}

/**
 * Un bac vient d'etre recharge d'un sachet sur la borne : on retire ce sachet de
 * la reserve livree au fitness.
 *
 * C'est le SEUL evenement qui fait baisser cette reserve. Le decompte des bacs,
 * lui, suit la consommation des boissons — deux choses distinctes : le bac se
 * vide en servant, la reserve se vide en rechargeant le bac.
 */
async function hopperRefill(body, res) {
  const { machine_id, hopper_name, hopper_id, grams } = body;
  const qty = Number.isFinite(grams) ? grams : 1000;
  const product = (hopper_name || hopper_id || "").trim();
  if (!machine_id || !product) return res.json({ ok: false, error: "MISSING_FIELDS" });

  try {
    await ensureGymStockTable();
    const [m] = await sql`SELECT gym_id FROM machines WHERE machine_id = ${machine_id}`;
    if (!m || !m.gym_id) {
      // Borne non rattachee a une salle : rien a decompter, ce n'est pas une erreur.
      return res.json({ ok: true, tracked: false });
    }
    const [row] = await sql`
      INSERT INTO gym_stock (gym_id, product, grams, updated_at)
      VALUES (${m.gym_id}, ${product}, ${-qty}, NOW())
      ON CONFLICT (gym_id, product) DO UPDATE
        SET grams = GREATEST(0, gym_stock.grams - ${qty}), updated_at = NOW()
      RETURNING grams`;
    const left = row ? row.grams : 0;

    if (left <= STOCK_ALERT_G) {
      const [g] = await sql`SELECT name FROM gyms WHERE id = ${m.gym_id}`;
      await sendAlertEmail(
        `📦 VOLT ${g?.name || "fitness"} — livraison à prévoir (${product})`,
        `Il ne reste que <strong>${(left / 1000).toFixed(1)} kg</strong> de
         <strong>${product}</strong> en réserve chez <strong>${g?.name || "ce fitness"}</strong>.
         <br/><br/>Le seuil d'alerte est fixé à ${(STOCK_ALERT_G / 1000).toFixed(1)} kg,
         soit un rechargement de bac d'avance. Prévoyez la prochaine livraison.`
      );
    }
    return res.json({ ok: true, tracked: true, grams_left: left });
  } catch (e) {
    console.error("[stock] hopper_refill:", e);
    return res.json({ ok: false, error: "SERVER_ERROR" });
  }
}

async function ensureFeedbackTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS feedback (
      id         SERIAL PRIMARY KEY,
      machine_id TEXT,
      message    TEXT NOT NULL,
      phone      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
}

/**
 * Message laisse par un client sur l'ecran d'aide de la borne.
 *
 * Le telephone est FACULTATIF : l'exiger ferait renoncer une partie des gens,
 * or un signalement anonyme reste utile pour comprendre une panne.
 */
async function clientFeedback(body, res) {
  const message = (body.message || "").trim().slice(0, 2000);
  const phone = (body.phone || "").trim().slice(0, 40);
  if (!message) return res.json({ ok: false, error: "EMPTY" });
  try {
    await ensureFeedbackTable();
    await sql`
      INSERT INTO feedback (machine_id, message, phone)
      VALUES (${body.machine_id || null}, ${message}, ${phone || null})`;
    await sendAlertEmail(
      `💬 VOLT — message d'un client${body.machine_id ? " (" + body.machine_id + ")" : ""}`,
      `${message.replace(/</g, "&lt;").replace(/\n/g, "<br/>")}
       <br/><br/><strong>Rappel :</strong> ${phone ? phone.replace(/</g, "&lt;") : "non communiqué"}`
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("[feedback]", e);
    return res.json({ ok: false, error: "SERVER_ERROR" });
  }
}

/** Envoi d'un email d'alerte a l'exploitant. Silencieux en cas d'echec. */
async function sendAlertEmail(subject, detail) {
  const to = process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL;
  if (!to || !process.env.RESEND_API_KEY) return;
  try {
    const { Resend } = require("resend");
    await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: "VOLT. <noreply@volt-energy.ch>",
      to,
      subject,
      html: `<div style="background:#040c22;padding:32px 16px;font-family:Arial,sans-serif">
        <div style="max-width:460px;margin:0 auto;background:#071433;border-radius:18px;overflow:hidden">
          <div style="padding:28px 32px 10px;font-size:52px;font-weight:900;color:#fff;letter-spacing:-2px;line-height:.9">VOLT.</div>
          <div style="height:4px;width:44px;background:#FF9500;margin:0 32px 22px;border-radius:2px"></div>
          <div style="padding:0 32px 26px;font-size:14px;color:rgba(255,255,255,.72);line-height:1.8">${detail}</div>
          <div style="padding:14px 32px;border-top:1px solid rgba(255,255,255,.06);font-size:11px;color:rgba(255,255,255,.25)">
            Alerte automatique · ${new Date().toLocaleString("fr-CH", { timeZone: "Europe/Zurich" })}
          </div>
        </div></div>`,
    });
  } catch (e) {
    console.warn("[alerte] non envoyee:", e.message);
  }
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
