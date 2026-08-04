/**
 * VOLT. — Calcul centralisé des dates d'abonnement.
 *
 * RÈGLE MÉTIER :
 *   Un abonnement a une date de DÉBUT figée (sub_started_at) et une date de FIN
 *   figée (sub_expires_at). Une fois écrites en base, elles ne bougent plus.
 *   Elles ne sont recalculées QUE lors d'un nouvel acte : paiement réussi,
 *   activation manuelle par l'admin, ou consommation d'un mois offert.
 *
 * Toutes les dates sont calculées sur le calendrier Europe/Zurich :
 *   - début  = 00:00:00.000 (heure suisse) du jour de souscription
 *   - fin    = 23:59:59.999 (heure suisse) du dernier jour couvert
 *   Le client bénéficie donc de sa journée complète de fin.
 */

const TZ = "Europe/Zurich";

const DUR_MONTHS = { month: 1, quarter: 3, year: 12 };

/** Nombre de mois pour un plan, ou null si le plan est inconnu. */
function monthsForPlan(plan) {
  return DUR_MONTHS[plan] || null;
}

/** Décalage (ms) entre Europe/Zurich et UTC à un instant donné (gère l'heure d'été). */
function tzOffsetMs(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second)
  );
  // Intl ne renvoie pas les millisecondes : on compare donc à la seconde pleine.
  return asUTC - (date.getTime() - date.getMilliseconds());
}

/** Jour civil suisse (y, m 1-12, d) correspondant à un instant. */
function zurichParts(date) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const [y, m, d] = f.format(date).split("-").map(Number);
  return { y, m, d };
}

/** Instant UTC correspondant à une heure murale suisse (double passe = robuste aux changements d'heure). */
function zurichWallClock(y, m, d, hh, mm, ss, ms) {
  const naive = Date.UTC(y, m - 1, d, hh, mm, ss, ms);
  let guess = new Date(naive - tzOffsetMs(new Date(naive)));
  guess = new Date(naive - tzOffsetMs(guess));
  return guess;
}

/** 00:00:00.000 (heure suisse) du jour civil suisse contenant `date`. */
function startOfDayZurich(date) {
  const { y, m, d } = zurichParts(date);
  return zurichWallClock(y, m, d, 0, 0, 0, 0);
}

/** Dernier instant (23:59:59.999 heure suisse) du jour civil suisse contenant `date`. */
function endOfDayZurich(date) {
  const { y, m, d } = zurichParts(date);
  // Minuit du lendemain moins 1 ms : robuste aux changements d'heure.
  return new Date(zurichWallClock(y, m, d + 1, 0, 0, 0, 0).getTime() - 1);
}

/**
 * Fin d'un abonnement de `months` mois commencé le jour civil de `base`.
 *
 * CONVENTION : un abonnement d'1 mois démarré le 3 août couvre jusqu'au
 * 2 septembre 23:59:59 inclus (soit exactement 1 mois calendaire, pas 1 jour de plus).
 * Si le jour n'existe pas dans le mois cible (31 janv. -> février), on couvre
 * jusqu'au dernier jour de ce mois.
 */
function addMonthsEndOfDay(base, months) {
  const { y, m, d } = zurichParts(base);
  const idx = (m - 1) + months;
  const tY = y + Math.floor(idx / 12);
  const tM = ((idx % 12) + 12) % 12 + 1;           // 1-12
  const lastDay = new Date(Date.UTC(tY, tM, 0)).getUTCDate();

  if (d <= lastDay) {
    // veille de la date anniversaire, à 23:59:59.999
    return new Date(zurichWallClock(tY, tM, d, 0, 0, 0, 0).getTime() - 1);
  }
  // jour inexistant dans le mois cible -> dernier jour du mois
  const nY = tM === 12 ? tY + 1 : tY;
  const nM = tM === 12 ? 1 : tM + 1;
  return new Date(zurichWallClock(nY, nM, 1, 0, 0, 0, 0).getTime() - 1);
}

/** Parse une saisie "YYYY-MM-DD" (input type=date) -> début de journée suisse. Null si invalide. */
function parseDayInput(str) {
  if (typeof str !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return zurichWallClock(y, mo, d, 0, 0, 0, 0);
}

/**
 * Calcule le couple (début, fin) d'un abonnement.
 *
 * @param {object}  opts
 * @param {string}  opts.plan             'month' | 'quarter' | 'year'
 * @param {Date}    [opts.now]            instant de référence (défaut: maintenant)
 * @param {Date}    [opts.startAt]        date de début imposée (activation manuelle)
 * @param {Date}    [opts.currentExpires] sub_expires_at actuel en base
 * @param {boolean} [opts.extend]         true = prolonger l'abo en cours au lieu de repartir de zéro
 * @returns {{ startedAt: Date, expiresAt: Date, days: number, extended: boolean }}
 */
function computeSubscription({ plan, now = new Date(), startAt = null, currentExpires = null, extend = false }) {
  const months = monthsForPlan(plan);
  if (!months) throw new Error("Plan invalide");

  const cur = currentExpires ? new Date(currentExpires) : null;
  const stillActive = !!(cur && !isNaN(cur) && cur > now);

  let startedAt, expiresAt;

  if (extend && stillActive) {
    // Renouvellement anticipé : on repart de la fin actuelle, le client ne perd rien.
    startedAt = startOfDayZurich(cur);
    expiresAt = addMonthsEndOfDay(cur, months);
  } else {
    startedAt = startOfDayZurich(startAt || now);
    expiresAt = addMonthsEndOfDay(startedAt, months);
  }

  const days = Math.round((expiresAt.getTime() - startedAt.getTime() + 1) / 86400000);
  return { startedAt, expiresAt, days, extended: !!(extend && stillActive) };
}

/** Jours restants (entier, >= 0) avant expiration. */
function daysLeft(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  const e = new Date(expiresAt);
  if (isNaN(e)) return null;
  return Math.max(0, Math.ceil((e - now) / 86400000));
}

/** Formatage FR-CH court, ex. "3 sept. 2026". Renvoie '—' si vide. */
function fmtCH(date) {
  if (!date) return "—";
  const d = new Date(date);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString("fr-CH", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
}

/**
 * Fenêtre d'abonnement d'une durée exacte en JOURS (activation manuelle ciblée,
 * ex. offrir 1 jour d'essai). Le jour de début compte comme jour 1.
 *
 * @param {object} opts
 * @param {number} opts.days     nombre de jours, entier >= 1
 * @param {Date}   [opts.startAt] date de début (défaut: aujourd'hui, heure suisse)
 */
function computeCustomWindow({ days, startAt = null }) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1) throw new Error("Nombre de jours invalide");
  const startedAt = startOfDayZurich(startAt || new Date());
  // jour 1 = jour de début inclus -> on ajoute (n-1) jours CIVILS (pas de ms bruts,
  // pour rester robuste face au changement d'heure).
  const { y, m, d } = zurichParts(startedAt);
  const lastDay = new Date(Date.UTC(y, m - 1, d + (n - 1)));   // arithmétique de date UTC neutre, fiable
  const expiresAt = endOfDayZurich(zurichWallClock(
    lastDay.getUTCFullYear(), lastDay.getUTCMonth() + 1, lastDay.getUTCDate(), 0, 0, 0, 0
  ));
  return { startedAt, expiresAt, days: n };
}

/**
 * Nombre de jours civils suisses couverts par une pause, bornes incluses.
 * Ex. du 10 au 24 août = 15 jours.
 */
function pauseDayCount(from, to) {
  const a = startOfDayZurich(from);
  const b = startOfDayZurich(to);
  return Math.round((b.getTime() - a.getTime()) / 86400000) + 1;
}

/**
 * Décale une date de fin d'abonnement de `days` jours civils suisses,
 * en conservant la fin de journée (23:59:59.999 heure suisse).
 */
function shiftExpiryByDays(expiresAt, days) {
  const e = new Date(expiresAt);
  if (isNaN(e)) throw new Error("Date de fin invalide");
  const { y, m, d } = zurichParts(e);
  const target = new Date(Date.UTC(y, m - 1, d + days));
  return endOfDayZurich(zurichWallClock(
    target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), 12, 0, 0, 0
  ));
}

/** Une pause est-elle en cours à cet instant ? */
function isPaused(pausedFrom, pausedTo, now = new Date()) {
  if (!pausedFrom || !pausedTo) return false;
  const f = new Date(pausedFrom), t = new Date(pausedTo);
  if (isNaN(f) || isNaN(t)) return false;
  return now >= f && now <= t;
}

module.exports = {
  TZ, DUR_MONTHS,
  monthsForPlan, computeSubscription, computeCustomWindow, daysLeft,
  startOfDayZurich, endOfDayZurich, addMonthsEndOfDay,
  pauseDayCount, shiftExpiryByDays, isPaused,
  parseDayInput, zurichParts, fmtCH,
};
