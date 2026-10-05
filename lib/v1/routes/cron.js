// Tâches planifiées. Vercel Cron appelle /api/v1/cron/tick toutes les heures ;
// chaque tâche s'exécute à son heure de Zurich (indépendant de l'heure d'été) et une seule fois (cron_runs).
const crypto = require("crypto");
const db = require("../db");
const R = require("../rules");
const { fail } = require("../http");
const mail = require("../mail");
const { monthlyReportPdf } = require("../pdf");

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const monthLabel = (first) => `${MONTHS_FR[Number(first.slice(5, 7)) - 1]} ${first.slice(0, 4)}`;

// Exécute la tâche si elle n'a pas déjà tourné pour cette clé (ex. date du jour).
async function once(sql, job, runKey, fn) {
  const r = await sql`INSERT INTO cron_runs (job, run_key) VALUES (${job}, ${runKey}) ON CONFLICT DO NOTHING RETURNING job`;
  if (!r.length) return "déjà fait";
  try {
    return await fn();
  } catch (e) {
    await sql`DELETE FROM cron_runs WHERE job = ${job} AND run_key = ${runKey}`; // réessai à la prochaine heure
    throw e;
  }
}

// Totaux du mois courant et du précédent (toujours complets : la purge ne touche que > 6 mois).
async function aggregateMonthly(sql, today) {
  for (const month of [R.firstOfMonth(today), R.prevMonth(today)]) {
    await sql`
      INSERT INTO passages_monthly (gym_id, month, ok_count, refused_count, distinct_members)
      SELECT g.id, ${month}::date,
        count(p.id) FILTER (WHERE p.result = 'ok'),
        count(p.id) FILTER (WHERE p.result NOT IN ('ok','relais')),
        count(DISTINCT p.member_id) FILTER (WHERE p.result = 'ok')
      FROM gyms g LEFT JOIN passages p ON p.gym_id = g.id
        AND p.ts >= (${month}::date AT TIME ZONE 'Europe/Zurich')
        AND p.ts < ((${month}::date + interval '1 month') AT TIME ZONE 'Europe/Zurich')
      GROUP BY g.id
      ON CONFLICT (gym_id, month) DO UPDATE SET ok_count = EXCLUDED.ok_count,
        refused_count = EXCLUDED.refused_count, distinct_members = EXCLUDED.distinct_members`;
  }
}

async function nightly(sql, today) {
  await aggregateMonthly(sql, today);
  const [p] = await sql`WITH d AS (DELETE FROM passages WHERE ts < now() - interval '6 months' RETURNING 1) SELECT count(*)::int AS n FROM d`;
  const [a] = await sql`WITH d AS (DELETE FROM autocontrols WHERE day < (now() - interval '2 years')::date RETURNING 1) SELECT count(*)::int AS n FROM d`;
  await sql`DELETE FROM rate_hits WHERE at < now() - interval '1 day'`;
  await sql`DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'`;
  await sql`DELETE FROM admin_audit WHERE at < now() - interval '2 years'`;
  return { passages_supprimes: p.n, autocontroles_supprimes: a.n };
}

async function gymDaily(sql, today) {
  const in14 = R.addDays(today, 14), yesterday = R.addDays(today, -1);
  const gyms = await sql`
    SELECT g.id, g.name, g.contact_email, g.contract_status,
      (SELECT array_agg(u.email) FROM gym_users u WHERE u.gym_id = g.id) AS user_emails,
      EXISTS (SELECT 1 FROM stations s WHERE s.gym_id = g.id) AS has_station,
      EXISTS (SELECT 1 FROM autocontrols a WHERE a.gym_id = g.id AND a.day = ${yesterday}::date) AS ac_done
    FROM gyms g`;
  let sent = 0;
  for (const g of gyms) {
    const expiring = await sql`
      SELECT prenom, nom, fin::text AS fin FROM members
      WHERE gym_id = ${g.id} AND fin = ${in14}::date AND statut <> 'bloque' ORDER BY nom`;
    const missing = g.has_station && g.contract_status === "signe" && !g.ac_done;
    if (!expiring.length && !missing) continue;
    for (const to of new Set([g.contact_email, ...(g.user_emails || [])].filter(Boolean))) {
      await mail.sendGymDaily(to, g, expiring, missing);
      sent++;
    }
  }
  return { emails: sent };
}

async function adminRecap(sql, today) {
  const fr = (d) => d.split("-").reverse().join(".");
  const lastDeliveries = await sql`
    SELECT DISTINCT ON (d.gym_id) g.name, d.delivered_on::text AS delivered_on, d.stock_days
    FROM deliveries d JOIN gyms g ON g.id = d.gym_id ORDER BY d.gym_id, d.delivered_on DESC`;
  const deliveries = lastDeliveries
    .map((d) => ({ ...d, s: R.deliveryStatus(d.delivered_on, d.stock_days, today) }))
    .filter((d) => d.s.left <= 7)
    .map((d) => `${d.name} — ${d.s.left < 0 ? "en retard depuis le" : "le"} ${fr(d.s.next)}`);
  const stations = await sql`
    SELECT s.name, g.name AS gym, s.installed_on::text AS installed_on, s.next_maintenance_on::text AS planned_on,
      (SELECT max(done_on)::text FROM maintenances m WHERE m.station_id = s.id AND m.type = 'Semestriel') AS last_semestriel,
      s.last_heartbeat, (s.last_heartbeat IS NULL OR s.last_heartbeat < now() - interval '2 hours') AS offline,
      (s.tablet_token_hash IS NOT NULL) AS provisioned
    FROM stations s JOIN gyms g ON g.id = s.gym_id`;
  const maintenances = stations
    .map((s) => ({ ...s, next: R.nextMaintenance(s) }))
    .filter((s) => s.next && R.daysBetween(today, s.next) <= 14)
    .map((s) => `${s.gym} · ${s.name} — ${s.planned_on ? "planifié le" : "à planifier avant le"} ${fr(s.next)}`);
  const offline = stations.filter((s) => s.provisioned && s.offline)
    .map((s) => `${s.gym} · ${s.name} — ${s.last_heartbeat ? "dernier signal " + new Date(s.last_heartbeat).toLocaleString("fr-CH", { timeZone: R.TZ }) : "jamais connectée"}`);
  if (!deliveries.length && !maintenances.length && !offline.length) return { email: false };
  await mail.sendAdminRecap({ deliveries, maintenances, offline });
  return { email: true };
}

async function monthlyReports(sql, today) {
  const month = R.prevMonth(today);
  const lastDay = R.addDays(R.firstOfMonth(today), -1);
  const days = Number(lastDay.slice(8, 10));
  const label = monthLabel(month);
  const gyms = await sql`
    SELECT g.id, g.name, g.contact_email, (SELECT array_agg(u.email) FROM gym_users u WHERE u.gym_id = g.id) AS user_emails,
      COALESCE(pm.ok_count, 0) AS ok_count, COALESCE(pm.refused_count, 0) AS refused_count, COALESCE(pm.distinct_members, 0) AS distinct_members,
      (SELECT count(*)::int FROM members m WHERE m.gym_id = g.id AND m.statut <> 'bloque' AND m.debut <= ${lastDay}::date AND m.fin >= ${lastDay}::date) AS active_members,
      (SELECT count(*)::int FROM autocontrols a WHERE a.gym_id = g.id AND a.day >= ${month}::date AND a.day <= ${lastDay}::date) AS autocontrols,
      (SELECT count(*)::int FROM anomalies n JOIN autocontrols a ON a.id = n.autocontrol_id
         WHERE a.gym_id = g.id AND a.day >= ${month}::date AND a.day <= ${lastDay}::date) AS anomalies,
      (SELECT count(*)::int FROM deliveries d WHERE d.gym_id = g.id AND d.delivered_on >= ${month}::date AND d.delivered_on <= ${lastDay}::date) AS deliveries,
      EXISTS (SELECT 1 FROM stations s WHERE s.gym_id = g.id) AS has_station
    FROM gyms g LEFT JOIN passages_monthly pm ON pm.gym_id = g.id AND pm.month = ${month}::date`;
  let sent = 0;
  for (const g of gyms.filter((x) => x.has_station)) {
    const pdf = await monthlyReportPdf({ gym: g, monthLabel: label, stats: { ...g, days } });
    const filename = `rapport-volt-${month.slice(0, 7)}.pdf`;
    for (const to of new Set([g.contact_email, ...(g.user_emails || []), mail.VOLT_EMAIL()].filter(Boolean))) {
      await mail.sendMonthlyReport(to, g, label, pdf, filename);
      sent++;
    }
  }
  return { emails: sent };
}

module.exports = function register(route) {
  route("GET", "/cron/tick", async ({ req, query }) => {
    // Si CRON_SECRET est défini, Vercel l'envoie et il est exigé. Sinon, seul le passage horaire est permis :
    // chaque tâche ne tourne qu'à son heure et une fois par jour (cron_runs), donc un appel externe est sans effet.
    const expected = process.env.CRON_SECRET || "";
    const got = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const authorized = expected && got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
    if ((expected || query.job) && !authorized) fail(401, "Non autorisé.");
    const sql = db();
    const now = new Date();
    const today = R.todayZurich(now);
    // ?job=… permet de lancer une tâche à la main (toujours protégé par CRON_SECRET).
    const hour = query.job ? null : R.hourZurich(now);
    const want = (job, h) => (query.job ? query.job === job : hour === h);
    const done = {};
    if (want("nightly", 3)) done.nightly = await once(sql, "nightly", today, () => nightly(sql, today));
    if (want("monthly", 7) && (query.job || today.endsWith("-01"))) done.monthly = await once(sql, "monthly", today.slice(0, 7), () => monthlyReports(sql, today));
    if (want("gym_daily", 8)) done.gym_daily = await once(sql, "gym_daily", today, () => gymDaily(sql, today));
    if (want("admin_recap", 8)) done.admin_recap = await once(sql, "admin_recap", today, () => adminRecap(sql, today));
    return { today, hour, done };
  });
};
