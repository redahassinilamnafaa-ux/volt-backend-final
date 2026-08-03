// ══════════════════════════════════════════════════════════════════════════════
// VOLT — Période d'abonnement : début et fin FIGÉS
//
// POURQUOI CE MODULE. Jusqu'ici, chaque endroit qui activait un abonnement
// recalculait la date de fin à partir de `new Date()` au moment de l'écriture,
// et personne n'enregistrait la date de DÉBUT. Conséquences constatées :
//
//   • une réactivation admin (double-clic, geste commercial refait, abonnement
//     repassé à false par l'expiration automatique puis réactivé) repoussait la
//     fin d'autant de jours ;
//   • le webhook TWINT écrivait `now + 30 jours` alors que pay-confirm écrivait
//     « même quantième du mois suivant » : deux fins différentes pour le même
//     paiement selon celui qui gagnait la course ;
//   • sans date de début, l'app cliente retombait sur `new Date()` et affichait
//     une échéance qui avançait d'un jour... chaque jour.
//
// RÈGLE. La période est calculée UNE SEULE FOIS, à l'activation, puis stockée
// telle quelle dans users.sub_started_at / users.sub_expires_at. Aucun chemin
// de LECTURE ne doit jamais la recalculer.
//
// ANCRAGE. Tout est ancré sur le calendrier d'Europe/Zurich (VOLT. est suisse) :
// le début est le premier instant du jour d'activation, la fin le dernier
// instant du jour qui précède le quantième anniversaire. Un « 1 mois » souscrit
// le 3 août court donc du 3 août 00:00 au 2 septembre 23:59:59 — exactement un
// mois de service, ni un jour de plus, et la date affichée est bien le dernier
// jour réellement utilisable.
// ══════════════════════════════════════════════════════════════════════════════

const sql = require("./db");

const TZ = "Europe/Zurich";

// Durée de chaque formule, en mois.
const PLAN_MONTHS = { month: 1, quarter: 3, year: 12 };

// ── Fuseau : conversion instant UTC ⇄ heure murale de Zurich ─────────────────

const PARTS_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function zurichFields(date) {
  const p = {};
  for (const { type, value } of PARTS_FMT.formatToParts(date)) p[type] = value;
  return {
    year:   Number(p.year),
    month:  Number(p.month),
    day:    Number(p.day),
    // Intl rend « 24 » pour minuit dans certaines versions de Node.
    hour:   Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

// Décalage Zurich↔UTC (en ms) en vigueur à cet instant : +1h en hiver, +2h en été.
function zurichOffsetMs(date) {
  const f = zurichFields(date);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second) -
         Math.floor(date.getTime() / 1000) * 1000;
}

// Instant UTC correspondant à une heure murale zurichoise donnée.
// Deux passes : la première estime le décalage, la seconde le corrige si
// l'estimation tombait du mauvais côté d'un changement d'heure.
function fromZurich(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  let ts = wall - zurichOffsetMs(new Date(wall));
  ts = wall - zurichOffsetMs(new Date(ts));
  return new Date(ts);
}

// ── Bornes de journée ────────────────────────────────────────────────────────

/** Premier instant (00:00:00.000 Zurich) du jour contenant `date`. */
function startOfDay(date) {
  const f = zurichFields(date);
  return fromZurich(f.year, f.month, f.day);
}

/** Dernier instant (23:59:59.999 Zurich) du jour contenant `date`. */
function endOfDay(date) {
  const f = zurichFields(date);
  return new Date(fromZurich(f.year, f.month, f.day + 1).getTime() - 1);
}

// ── Arithmétique calendaire ──────────────────────────────────────────────────

// Ajoute `n` mois en bornant le quantième au dernier jour du mois cible :
// 31 janvier + 1 mois = 28 (ou 29) février, jamais le 2 ou 3 mars.
function addMonths(year, month, day, n) {
  const total   = (year * 12) + (month - 1) + n;
  const tYear   = Math.floor(total / 12);
  const tMonth  = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(tYear, tMonth, 0)).getUTCDate();
  return { year: tYear, month: tMonth, day: Math.min(day, lastDay) };
}

/**
 * Calcule la période d'un abonnement. Déterministe : mêmes entrées ⇒ mêmes
 * sorties, quel que soit le moment de l'appel dans la journée.
 *
 * @param {string} plan        'month' | 'quarter' | 'year'
 * @param {Date}   [startFrom] jour de départ (par défaut : maintenant)
 * @returns {{ start: Date, end: Date, months: number, days: number }}
 */
function computePeriod(plan, startFrom) {
  const months = PLAN_MONTHS[plan];
  if (!months) throw new Error(`Plan inconnu : ${plan}`);

  const base  = startFrom ? new Date(startFrom) : new Date();
  const f     = zurichFields(base);
  const start = fromZurich(f.year, f.month, f.day);

  // Fin = veille du quantième anniversaire, à 23:59:59.999.
  const anniv = addMonths(f.year, f.month, f.day, months);
  const end   = new Date(fromZurich(anniv.year, anniv.month, anniv.day).getTime() - 1);

  return { start, end, months, days: daysBetween(start, end) };
}

/**
 * Reconstitue la date de début d'un abonnement historique dont seule la fin a
 * été enregistrée — les lignes créées avant l'ajout de users.sub_started_at.
 * On remonte de `months` depuis le quantième anniversaire, ce qui retombe sur
 * le bon jour aussi bien pour les fins au nouveau format (veille à 23:59:59)
 * que pour les anciennes (minuit UTC du quantième).
 */
function derivePeriodStart(plan, end) {
  const months = PLAN_MONTHS[plan];
  if (!end || !months) return null;
  const anniv = zurichFields(new Date(new Date(end).getTime() + 1));
  const back  = addMonths(anniv.year, anniv.month, anniv.day, -months);
  return fromZurich(back.year, back.month, back.day);
}

/**
 * Prolonge une fin de période de `months` mois (mois offert, geste commercial)
 * sans jamais toucher au début. Si la période est déjà terminée, on repart de
 * la fin de la journée courante.
 */
function extendPeriodEnd(end, months) {
  const base = end && new Date(end) > new Date() ? new Date(end) : endOfDay(new Date());
  const f    = zurichFields(base);
  const t    = addMonths(f.year, f.month, f.day, months);
  return endOfDay(fromZurich(t.year, t.month, t.day));
}

/** Nombre de jours de service couverts par la période (bornes incluses). */
function daysBetween(start, end) {
  if (!start || !end) return 0;
  return Math.max(0, Math.round((endOfDay(end) - startOfDay(start)) / 86400000));
}

/** Jours restants à partir d'aujourd'hui (0 si la période est terminée). */
function daysRemaining(end) {
  if (!end) return 0;
  const diff = endOfDay(new Date(end)) - startOfDay(new Date());
  return diff <= 0 ? 0 : Math.round(diff / 86400000);
}

// ── Saisie / affichage ───────────────────────────────────────────────────────

/** 'YYYY-MM-DD' (calendrier de Zurich) — format des <input type="date">. */
function toDayString(date) {
  if (!date) return null;
  const f = zurichFields(new Date(date));
  return `${f.year}-${String(f.month).padStart(2, "0")}-${String(f.day).padStart(2, "0")}`;
}

/** 'YYYY-MM-DD' ⇒ premier instant de ce jour à Zurich. */
function parseDayStart(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!m) return null;
  return fromZurich(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** 'YYYY-MM-DD' ⇒ dernier instant de ce jour à Zurich (fin de couverture). */
function parseDayEnd(value) {
  const start = parseDayStart(value);
  return start ? endOfDay(start) : null;
}

/** « 3 août 2026 » — affichage humain, toujours en heure suisse. */
function formatDay(date) {
  if (!date) return null;
  return new Date(date).toLocaleDateString("fr-CH", {
    timeZone: TZ, day: "numeric", month: "long", year: "numeric",
  });
}

/** « 3 août 2026 » en version courte pour les tableaux : « 3 août 26 ». */
function formatDayShort(date) {
  if (!date) return null;
  return new Date(date).toLocaleDateString("fr-CH", {
    timeZone: TZ, day: "numeric", month: "short", year: "2-digit",
  });
}

/**
 * Bloc de dates prêt à être renvoyé par l'API (tableaux admin/fitness, app).
 * `null` partout tant qu'aucun abonnement n'a été activé. Si le début manque
 * (ligne antérieure à la colonne sub_started_at), il est reconstitué depuis la
 * fin et la formule — `sub_start_estimated` le signale.
 */
function subscriptionDates(startedAt, expiresAt, plan) {
  const end       = expiresAt ? new Date(expiresAt) : null;
  const estimated = !startedAt && !!end && !!PLAN_MONTHS[plan];
  const start     = startedAt ? new Date(startedAt)
                  : estimated ? derivePeriodStart(plan, end)
                  : null;
  return {
    sub_start_estimated: estimated,
    sub_started_at:  start ? start.toISOString() : null,
    sub_expires_at:  end   ? end.toISOString()   : null,
    sub_start_day:   toDayString(start),
    sub_end_day:     toDayString(end),
    sub_start_label: formatDayShort(start),
    sub_end_label:   formatDayShort(end),
    sub_days_total:  start && end ? daysBetween(start, end) : null,
    sub_days_left:   end ? daysRemaining(end) : null,
    sub_expired:     end ? daysRemaining(end) === 0 : null,
  };
}

// ── Schéma ───────────────────────────────────────────────────────────────────

// users.sub_started_at n'existait pas : on l'ajoute à la volée. Mémoïsé pour
// n'exécuter l'ALTER qu'une fois par lambda chaude.
let columnsReady = null;
function ensureSubscriptionColumns() {
  if (!columnsReady) {
    columnsReady = sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_started_at TIMESTAMPTZ`
      .catch(e => { columnsReady = null; throw e; });
  }
  return columnsReady;
}

module.exports = {
  TZ,
  PLAN_MONTHS,
  computePeriod,
  derivePeriodStart,
  extendPeriodEnd,
  startOfDay,
  endOfDay,
  daysBetween,
  daysRemaining,
  toDayString,
  parseDayStart,
  parseDayEnd,
  formatDay,
  formatDayShort,
  subscriptionDates,
  ensureSubscriptionColumns,
};
