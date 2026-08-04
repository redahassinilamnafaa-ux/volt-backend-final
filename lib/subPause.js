/**
 * VOLT. — Pause d'abonnement (vacances, blessure, absence).
 *
 * DIFFÉRENCE AVEC "BLOQUER" :
 *   - Bloquer  = sanction. L'accès est coupé, la date de fin CONTINUE de courir.
 *   - Pause    = gel. L'accès est coupé pendant la fenêtre choisie, et la date de
 *                fin est repoussée d'autant : le client ne perd aucun jour payé.
 *
 * Les dates de pause sont saisies à l'avance (du X au Y). La date de fin est
 * recalculée UNE SEULE FOIS, au moment où la pause est posée — conformément au
 * principe "les dates ne bougent pas toutes seules".
 */

const { parseDayInput, startOfDayZurich, endOfDayZurich, pauseDayCount, shiftExpiryByDays, fmtCH } = require("./subscription");
const { logSubEvent } = require("./subEvents");

async function ensurePauseColumns(sql) {
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_paused_from TIMESTAMPTZ`.catch(() => {});
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_paused_to   TIMESTAMPTZ`.catch(() => {});
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_paused_days INTEGER`.catch(() => {});
}

/**
 * Pose une pause sur l'abonnement d'un utilisateur.
 * @returns {{ok:true, ...}} ou {{error:string, status:number}}
 */
async function setPause(sql, { user_id, from, to, source }) {
  await ensurePauseColumns(sql);

  const [u] = await sql`
    SELECT id, subscribed, sub_started_at, sub_expires_at, sub_paused_from, sub_paused_to, plan
    FROM users WHERE id = ${user_id}`;
  if (!u) return { error: "Client introuvable.", status: 404 };
  if (!u.subscribed || !u.sub_expires_at) {
    return { error: "Ce client n'a pas d'abonnement actif à mettre en pause.", status: 400 };
  }
  if (u.sub_paused_from && u.sub_paused_to && new Date(u.sub_paused_to) > new Date()) {
    return { error: "Une pause est déjà planifiée ou en cours. Annule-la d'abord.", status: 400 };
  }

  const fromD = parseDayInput(from);
  const toD   = parseDayInput(to);
  if (!fromD || !toD) return { error: "Dates invalides (format attendu AAAA-MM-JJ).", status: 400 };
  if (toD < fromD)    return { error: "La date de fin de pause doit être après la date de début.", status: 400 };

  const todayStart = startOfDayZurich(new Date());
  if (fromD < todayStart) return { error: "La pause ne peut pas commencer dans le passé.", status: 400 };

  const currentExpiry = new Date(u.sub_expires_at);
  if (fromD > currentExpiry) {
    return { error: "La pause commence après la fin de l'abonnement.", status: 400 };
  }

  const days      = pauseDayCount(fromD, toD);
  const pausedTo  = endOfDayZurich(toD);
  const newExpiry = shiftExpiryByDays(currentExpiry, days);

  await sql`
    UPDATE users
    SET sub_paused_from = ${fromD},
        sub_paused_to   = ${pausedTo},
        sub_paused_days = ${days},
        sub_expires_at  = ${newExpiry}
    WHERE id = ${user_id}`;

  await logSubEvent(sql, {
    user_id, event_type: 'paused', source,
    plan: u.plan, days,
    sub_started_at: u.sub_started_at, sub_expires_at: newExpiry,
    note: `Pause du ${fmtCH(fromD)} au ${fmtCH(pausedTo)} (${days} j) — fin repoussée au ${fmtCH(newExpiry)}.`,
  });

  return {
    ok: true, days,
    paused_from: fmtCH(fromD), paused_to: fmtCH(pausedTo),
    sub_end: fmtCH(newExpiry),
    sub_expires_at: newExpiry.toISOString(),
  };
}

/**
 * Annule une pause. Si elle n'a pas commencé, on rend tous les jours crédités.
 * Si elle est en cours, on la clôture aujourd'hui et on ne garde que les jours
 * réellement consommés.
 */
async function cancelPause(sql, { user_id, source }) {
  await ensurePauseColumns(sql);

  const [u] = await sql`
    SELECT id, plan, sub_started_at, sub_expires_at, sub_paused_from, sub_paused_to, sub_paused_days
    FROM users WHERE id = ${user_id}`;
  if (!u) return { error: "Client introuvable.", status: 404 };
  if (!u.sub_paused_from || !u.sub_paused_to) {
    return { error: "Aucune pause à annuler.", status: 400 };
  }

  const now       = new Date();
  const fromD     = new Date(u.sub_paused_from);
  const credited  = u.sub_paused_days || pauseDayCount(fromD, new Date(u.sub_paused_to));

  // Jours réellement consommés : 0 si la pause n'a pas commencé,
  // sinon du début jusqu'à aujourd'hui inclus.
  const consumed  = now < fromD ? 0 : Math.min(credited, pauseDayCount(fromD, now));
  const toGiveBack = credited - consumed;

  const newExpiry = toGiveBack > 0
    ? shiftExpiryByDays(new Date(u.sub_expires_at), -toGiveBack)
    : new Date(u.sub_expires_at);

  await sql`
    UPDATE users
    SET sub_paused_from = NULL, sub_paused_to = NULL, sub_paused_days = NULL,
        sub_expires_at  = ${newExpiry}
    WHERE id = ${user_id}`;

  await logSubEvent(sql, {
    user_id, event_type: 'pause_cancelled', source,
    plan: u.plan, days: consumed || null,
    sub_started_at: u.sub_started_at, sub_expires_at: newExpiry,
    note: consumed === 0
      ? `Pause annulée avant son début — ${credited} j restitués, fin ramenée au ${fmtCH(newExpiry)}.`
      : `Pause interrompue après ${consumed} j — fin ajustée au ${fmtCH(newExpiry)}.`,
  });

  return { ok: true, consumed, sub_end: fmtCH(newExpiry), sub_expires_at: newExpiry.toISOString() };
}

module.exports = { ensurePauseColumns, setPause, cancelPause };
