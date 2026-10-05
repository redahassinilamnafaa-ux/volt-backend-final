// Règles métier VOLT. v1 — fonctions pures (testées dans test/rules.test.js).
// Dates métier au format 'YYYY-MM-DD', fuseau Europe/Zurich.

const TZ = "Europe/Zurich";
const COOLDOWN_S = 900;
const OFFLINE_MAX_H = 72;

const ymdFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" });

// Date du jour (ou d'un instant) à Zurich.
function todayZurich(at = new Date()) {
  return ymdFmt.format(at);
}

function hourZurich(at = new Date()) {
  return Number(hourFmt.format(at));
}

// Normalise une valeur date (string ou Date renvoyée par le driver) en 'YYYY-MM-DD'.
function ymd(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function isValidYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(s, n) {
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const [y1, m1, d1] = a.split("-").map(Number);
  const [y2, m2, d2] = b.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// Fin d'abonnement = début + N mois − 1 jour (05.10 → 04.11).
// Si le jour n'existe pas dans le mois cible (31.01 + 1 mois), fin = dernier jour de ce mois (28/29.02).
function computeEnd(debut, months) {
  const [y, m, d] = debut.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const ty = target.getUTCFullYear(), tm = target.getUTCMonth();
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  if (d > lastDay) return new Date(Date.UTC(ty, tm, lastDay)).toISOString().slice(0, 10);
  return addDays(new Date(Date.UTC(ty, tm, d)).toISOString().slice(0, 10), -1);
}

// '1m' | '12m' | 'Nm' (1–36) → nombre de mois, sinon null.
function parseDuree(duree) {
  const m = /^(\d{1,2})m$/.exec(duree || "");
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 36 ? n : null;
}

// Code badge : sans espaces ni tirets, majuscules, 6–40 caractères.
function normalizeCode(code) {
  const c = String(code || "").replace(/[\s-]+/g, "").toUpperCase();
  return /^[A-Z0-9]{6,40}$/.test(c) ? c : null;
}

// Statut calculé d'un membre.
function memberStatus(m, today) {
  if (m.statut === "bloque") return "bloque";
  const reprise = ymd(m.reprise);
  if (m.statut === "pause" && (!reprise || reprise > today)) return "pause";
  if (ymd(m.debut) > today) return "avenir";
  if (ymd(m.fin) < today) return "expire";
  return "actif";
}

// Décision de distribution (même logique côté tablette hors ligne).
// member : null si code inconnu ; lastOkAt : Date du dernier passage 'ok' ou null.
function authorize({ member, lastOkAt, now = new Date(), cooldownS = COOLDOWN_S }) {
  if (!member) return { result: "unknown", log: "inconnu" };
  const st = memberStatus(member, todayZurich(now));
  if (st !== "actif") return { result: "inactive", reason: st, log: st };
  if (lastOkAt) {
    const elapsed = Math.floor((now - new Date(lastOkAt)) / 1000);
    if (elapsed >= 0 && elapsed < cooldownS) return { result: "wait", wait_s: cooldownS - elapsed, log: "delai" };
  }
  return { result: "ok", log: "ok" };
}

// Résultat tablette (ou valeur de passages.result) → valeur stockée dans passages.result.
const LOG_RESULTS = ["ok", "delai", "inconnu", "pause", "bloque", "expire", "avenir", "relais"];
function toLogResult(result, reason) {
  if (LOG_RESULTS.includes(result)) return result;
  if (result === "wait") return "delai";
  if (result === "unknown") return "inconnu";
  if (result === "inactive" && LOG_RESULTS.includes(reason)) return reason;
  return null;
}

// Prochaine échéance de livraison : date + jours de stock.
function deliveryStatus(delivered_on, stock_days, today) {
  const next = addDays(ymd(delivered_on), Number(stock_days));
  const left = daysBetween(today, next);
  return { next, left, status: left <= 7 ? "a_livrer" : "planifiee" };
}

// Prochain entretien : planifié, sinon dernier semestriel (ou installation) + 6 mois.
function nextMaintenance({ planned_on, last_semestriel, installed_on }) {
  if (planned_on) return ymd(planned_on);
  const base = ymd(last_semestriel) || ymd(installed_on);
  if (!base) return null;
  const [y, m, d] = base.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + 6, d)).toISOString().slice(0, 10);
}

function firstOfMonth(s) {
  return s.slice(0, 7) + "-01";
}

function prevMonth(s) {
  const [y, m] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
}

module.exports = {
  TZ, COOLDOWN_S, OFFLINE_MAX_H, LOG_RESULTS,
  todayZurich, hourZurich, ymd, isValidYmd, addDays, daysBetween, computeEnd, parseDuree,
  normalizeCode, memberStatus, authorize, toLogResult, deliveryStatus, nextMaintenance,
  firstOfMonth, prevMonth,
};
