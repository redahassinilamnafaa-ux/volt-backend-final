// Routes /admin/* — back-office VOLT. (rôle admin). Chaque appel est journalisé (admin_audit).
const bcrypt = require("bcryptjs");
const db = require("../db");
const R = require("../rules");
const produits = require("../../../data/v1/produits.json");
const M = require("../members");
const { fail } = require("../http");
const { requireUser, sha256, randomToken } = require("../auth");
const { emailOk, passwordOk } = require("./auth");
const { queryPassages } = require("./gym");
const mail = require("../mail");

const uuidOk = (s) => /^[0-9a-f-]{36}$/i.test(s || "");
const GYM_FIELDS = ["name", "legal_name", "ide", "address", "city", "filiale", "contact_name", "contact_email", "contact_phone", "contract_status", "suspended", "signed_on"];
const STATION_FIELDS = ["name", "location", "installed_on", "serve_signal", "relay_host", "blocked", "blocked_reason"];
const MAINT_TYPES = ["Semestriel", "Intervention", "Installation", "Contrôle", "Réparation"];

// SQL du statut « actif » (même règle que rules.memberStatus).
const ACTIVE_SQL = (today) => `m.statut <> 'bloque' AND NOT (m.statut = 'pause' AND (m.reprise IS NULL OR m.reprise > '${today}'))
  AND m.debut <= '${today}' AND m.fin >= '${today}'`;

function pick(body, fields) {
  const out = {};
  for (const f of fields) if (f in body) out[f] = body[f] === "" ? null : body[f];
  return out;
}

// UPDATE dynamique sur une liste blanche de colonnes.
async function updateRow(sql, table, id, values, extraWhere = "") {
  const keys = Object.keys(values);
  if (!keys.length) fail(400, "Rien à modifier.");
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const rows = await sql(`UPDATE ${table} SET ${sets} WHERE id = $1 ${extraWhere} RETURNING *`, [id, ...keys.map((k) => values[k])]);
  if (!rows.length) fail(404, "Introuvable.");
  return rows[0];
}

// Fréquentation du site public (table site_views, alimentée par POST /track). Une « visite » = première page
// ouverte depuis l'extérieur du site ; toutes les pages vues sont comptées dans « pages vues ».
async function siteStats(sql, { days, from, fromTs, prevTs }) {
  const [t] = await sql`
    SELECT count(*) FILTER (WHERE at >= ${fromTs}::timestamptz)::int AS views,
           count(*) FILTER (WHERE at >= ${fromTs}::timestamptz AND new_visit)::int AS visits,
           count(*) FILTER (WHERE at < ${fromTs}::timestamptz)::int AS views_prev,
           count(*) FILTER (WHERE at < ${fromTs}::timestamptz AND new_visit)::int AS visits_prev,
           count(*) FILTER (WHERE at >= ${fromTs}::timestamptz AND new_visit AND device = 'mobile')::int AS visits_mobile,
           count(*) FILTER (WHERE at >= now() - interval '30 minutes')::int AS live,
           count(*) FILTER (WHERE (at AT TIME ZONE 'Europe/Zurich')::date = (now() AT TIME ZONE 'Europe/Zurich')::date AND new_visit)::int AS visits_today
    FROM site_views WHERE at >= ${prevTs}::timestamptz`;
  const dailyRows = await sql`
    SELECT (at AT TIME ZONE 'Europe/Zurich')::date::text AS day, count(*)::int AS views, count(*) FILTER (WHERE new_visit)::int AS visits
    FROM site_views WHERE at >= ${fromTs}::timestamptz GROUP BY 1`;
  const byDay = Object.fromEntries(dailyRows.map((d) => [d.day, d]));
  const daily = Array.from({ length: days }, (_, i) => {
    const day = R.addDays(from, i);
    return { day, views: byDay[day]?.views || 0, visits: byDay[day]?.visits || 0 };
  });
  const pages = await sql(`
    SELECT path, count(*)::int AS views, count(*) FILTER (WHERE new_visit)::int AS entrees
    FROM site_views WHERE at >= $1::timestamptz GROUP BY path ORDER BY views DESC, path LIMIT 12`, [fromTs]);
  const sources = await sql(`
    SELECT coalesce(source, referrer, 'direct') AS source, count(*)::int AS visits
    FROM site_views WHERE at >= $1::timestamptz AND new_visit GROUP BY 1 ORDER BY visits DESC, 1 LIMIT 12`, [fromTs]);
  const places = await sql(`
    SELECT city, region, country, count(*)::int AS visits
    FROM site_views WHERE at >= $1::timestamptz AND new_visit AND (city IS NOT NULL OR country IS NOT NULL)
    GROUP BY city, region, country ORDER BY visits DESC, city NULLS LAST LIMIT 12`, [fromTs]);
  const countries = await sql(`
    SELECT coalesce(country, '?') AS country, count(*)::int AS visits
    FROM site_views WHERE at >= $1::timestamptz AND new_visit GROUP BY 1 ORDER BY visits DESC LIMIT 8`, [fromTs]);
  const devices = await sql(`
    SELECT coalesce(device, 'desktop') AS device, count(*)::int AS visits
    FROM site_views WHERE at >= $1::timestamptz AND new_visit GROUP BY 1 ORDER BY visits DESC`, [fromTs]);
  const hours = await sql(`
    SELECT extract(hour FROM at AT TIME ZONE 'Europe/Zurich')::int AS hour, count(*)::int AS visits
    FROM site_views WHERE at >= $1::timestamptz AND new_visit GROUP BY 1 ORDER BY 1`, [fromTs]);
  return { totals: t, daily, pages, sources, places, countries, devices, hours };
}

module.exports = function register(route) {
  const adminCtx = async (req) => {
    const s = requireUser(req, "admin");
    const sql = db();
    await sql`INSERT INTO admin_audit (user_id, method, path) VALUES (${s.uid}, ${req.method}, ${String(req.url).slice(0, 300)})`;
    return { s, sql, today: R.todayZurich() };
  };

  // ── Réseau ─────────────────────────────────────────────
  route("GET", "/admin/network", async ({ req }) => {
    const { sql, today } = await adminCtx(req);
    const yesterday = R.addDays(today, -1);
    const gyms = await sql(`
      SELECT g.id, g.name, g.city, g.contract_status,
        (SELECT count(*)::int FROM members m WHERE m.gym_id = g.id AND ${ACTIVE_SQL(today)}) AS actifs,
        (SELECT count(*)::int FROM members m WHERE m.gym_id = g.id) AS inscrits,
        (SELECT count(*)::int FROM passages p WHERE p.gym_id = g.id AND p.result = 'ok'
           AND p.ts >= (date_trunc('month', now() AT TIME ZONE 'Europe/Zurich') AT TIME ZONE 'Europe/Zurich')) AS passages_mois,
        (SELECT count(*)::int FROM passages p WHERE p.gym_id = g.id AND p.result NOT IN ('ok','relais')
           AND p.ts >= (date_trunc('month', now() AT TIME ZONE 'Europe/Zurich') AT TIME ZONE 'Europe/Zurich')) AS refus_mois,
        (SELECT count(*)::int FROM stations s WHERE s.gym_id = g.id) AS stations,
        (SELECT count(*)::int FROM stations s WHERE s.gym_id = g.id AND (s.last_heartbeat IS NULL OR s.last_heartbeat < now() - interval '2 hours')) AS stations_offline,
        (SELECT row_to_json(d) FROM (SELECT delivered_on::text AS delivered_on, stock_days FROM deliveries
           WHERE gym_id = g.id ORDER BY delivered_on DESC LIMIT 1) d) AS last_delivery,
        EXISTS (SELECT 1 FROM autocontrols a WHERE a.gym_id = g.id AND a.day = '${yesterday}') AS autocontrol_hier
      FROM gyms g ORDER BY g.name`);
    return {
      gyms: gyms.map((g) => {
        const alerts = [];
        if (g.stations_offline) alerts.push(`${g.stations_offline} station(s) hors ligne`);
        const d = g.last_delivery && R.deliveryStatus(g.last_delivery.delivered_on, g.last_delivery.stock_days, today);
        if (d && d.left <= 7) alerts.push(d.left < 0 ? "Livraison en retard" : `Livraison dans ${d.left} j`);
        if (g.stations && g.contract_status === "signe" && !g.autocontrol_hier) alerts.push("Autocontrôle d'hier manquant");
        return { ...g, next_delivery: d || null, alerts };
      }),
    };
  });

  // ── Statistiques d'exploitation ────────────────────────
  // Période glissante en jours de Zurich (aujourd'hui inclus) ; tout est agrégé en SQL.
  route("GET", "/admin/stats", async ({ req, query }) => {
    const { sql, today } = await adminCtx(req);
    const days = [7, 30, 90].includes(Number(query.days)) ? Number(query.days) : 30;
    const gymId = uuidOk(query.gym_id) ? query.gym_id : null;
    const from = R.addDays(today, -(days - 1));
    const prevFrom = R.addDays(from, -days);
    const in14 = R.addDays(today, 14), d30 = R.addDays(today, -30), yesterday = R.addDays(today, -1);
    const [{ t: fromAt }] = await sql`SELECT (${from}::date::timestamp AT TIME ZONE 'Europe/Zurich') AS t`;
    const [{ t: prevAt }] = await sql`SELECT (${prevFrom}::date::timestamp AT TIME ZONE 'Europe/Zurich') AS t`;
    const fromTs = new Date(fromAt).toISOString(), prevTs = new Date(prevAt).toISOString();

    const [tot] = await sql`
      SELECT count(*) FILTER (WHERE p.result = 'ok' AND p.ts >= ${fromTs}::timestamptz)::int AS ok,
             count(*) FILTER (WHERE p.result NOT IN ('ok','relais') AND p.ts >= ${fromTs}::timestamptz)::int AS refused,
             count(*) FILTER (WHERE p.result = 'relais' AND p.ts >= ${fromTs}::timestamptz)::int AS relay_failed,
             count(*) FILTER (WHERE p.result = 'ok' AND p.ts < ${fromTs}::timestamptz)::int AS ok_prev
      FROM passages p
      WHERE p.ts >= ${prevTs}::timestamptz AND (${gymId}::uuid IS NULL OR p.gym_id = ${gymId}::uuid)`;
    const dailyRows = await sql`
      SELECT (p.ts AT TIME ZONE 'Europe/Zurich')::date::text AS day,
             count(*) FILTER (WHERE p.result = 'ok')::int AS ok,
             count(*) FILTER (WHERE p.result NOT IN ('ok','relais'))::int AS refused
      FROM passages p
      WHERE p.ts >= ${fromTs}::timestamptz AND (${gymId}::uuid IS NULL OR p.gym_id = ${gymId}::uuid)
      GROUP BY 1`;
    const heatmap = await sql`
      SELECT extract(isodow FROM p.ts AT TIME ZONE 'Europe/Zurich')::int AS dow,
             extract(hour FROM p.ts AT TIME ZONE 'Europe/Zurich')::int AS hour, count(*)::int AS n
      FROM passages p
      WHERE p.result = 'ok' AND p.ts >= ${fromTs}::timestamptz AND (${gymId}::uuid IS NULL OR p.gym_id = ${gymId}::uuid)
      GROUP BY 1, 2`;
    const refusals = await sql`
      SELECT p.result, count(*)::int AS n FROM passages p
      WHERE p.result <> 'ok' AND p.ts >= ${fromTs}::timestamptz AND (${gymId}::uuid IS NULL OR p.gym_id = ${gymId}::uuid)
      GROUP BY 1 ORDER BY 2 DESC`;

    const rows = await sql(`
      SELECT g.id, g.name, g.contract_status,
        (SELECT count(*)::int FROM members m WHERE m.gym_id = g.id) AS inscrits,
        (SELECT count(*)::int FROM members m WHERE m.gym_id = g.id AND ${ACTIVE_SQL(today)}) AS actifs,
        (SELECT count(DISTINCT p.member_id)::int FROM passages p WHERE p.gym_id = g.id AND p.result = 'ok' AND p.ts >= $1::timestamptz) AS buveurs,
        (SELECT count(*)::int FROM members m WHERE m.gym_id = g.id AND ${ACTIVE_SQL(today)}
           AND NOT EXISTS (SELECT 1 FROM passages p WHERE p.member_id = m.id AND p.result = 'ok' AND p.ts >= $1::timestamptz)) AS jamais,
        (SELECT count(*)::int FROM passages p WHERE p.gym_id = g.id AND p.result = 'ok' AND p.ts >= $1::timestamptz) AS ok,
        (SELECT count(*)::int FROM passages p WHERE p.gym_id = g.id AND p.result NOT IN ('ok','relais') AND p.ts >= $1::timestamptz) AS refused,
        (SELECT count(*)::int FROM members m WHERE m.gym_id = g.id AND m.statut <> 'bloque' AND m.fin BETWEEN '${today}' AND '${in14}') AS expirent,
        (SELECT count(*)::int FROM members m WHERE m.gym_id = g.id AND m.statut <> 'bloque' AND m.fin BETWEEN '${d30}' AND '${yesterday}') AS expires_30j,
        (SELECT count(*)::int FROM stations s WHERE s.gym_id = g.id) AS stations,
        (SELECT count(*)::int FROM stations s WHERE s.gym_id = g.id AND s.tablet_token_hash IS NOT NULL
           AND (s.last_heartbeat IS NULL OR s.last_heartbeat < now() - interval '2 hours')) AS stations_offline,
        (SELECT count(*)::int FROM station_events e JOIN stations s ON s.id = e.station_id
           WHERE s.gym_id = g.id AND e.level <> 'info' AND e.at > now() - interval '24 hours') AS incidents_24h,
        (SELECT row_to_json(d) FROM (SELECT x.delivered_on::text AS delivered_on,
           (SELECT COALESCE(sum(i.qty), 0)::int FROM delivery_items i WHERE i.delivery_id = x.id) AS poches
           FROM deliveries x WHERE x.gym_id = g.id ORDER BY x.delivered_on DESC, x.created_at DESC LIMIT 1) d) AS last_delivery,
        (SELECT count(*)::int FROM passages p WHERE p.gym_id = g.id AND p.result = 'ok'
           AND p.ts >= ((SELECT max(x.delivered_on) FROM deliveries x WHERE x.gym_id = g.id)::timestamp AT TIME ZONE 'Europe/Zurich')) AS ok_depuis_livraison,
        (SELECT count(*)::int FROM passages p WHERE p.gym_id = g.id AND p.result = 'ok' AND p.ts >= now() - interval '14 days') AS ok_14j
      FROM gyms g WHERE $2::uuid IS NULL OR g.id = $2::uuid ORDER BY g.name`, [fromTs, gymId]);

    const expiring = await sql(`
      SELECT m.prenom, m.nom, m.fin::text AS fin, g.name AS gym FROM members m JOIN gyms g ON g.id = m.gym_id
      WHERE m.statut <> 'bloque' AND m.fin BETWEEN '${today}' AND '${in14}' AND ($1::uuid IS NULL OR m.gym_id = $1::uuid)
      ORDER BY m.fin, m.nom LIMIT 50`, [gymId]);
    const idle = await sql(`
      SELECT m.prenom, m.nom, m.debut::text AS debut, g.name AS gym FROM members m JOIN gyms g ON g.id = m.gym_id
      WHERE ${ACTIVE_SQL(today)} AND ($1::uuid IS NULL OR m.gym_id = $1::uuid)
        AND NOT EXISTS (SELECT 1 FROM passages p WHERE p.member_id = m.id AND p.result = 'ok' AND p.ts >= $2::timestamptz)
      ORDER BY g.name, m.nom LIMIT 50`, [gymId, fromTs]);

    // Une poche de 5 L au dosage standard (5 ml de concentré) = 1000 boissons.
    const perPouch = Math.round((produits.poche_l || 5) * 1000 / ((produits.dosage_standard || {}).concentre_ml || 5));
    const gyms = rows.map((g) => {
      const capacity = g.last_delivery ? g.last_delivery.poches * perPouch : null;
      const remaining = capacity == null ? null : Math.max(0, capacity - g.ok_depuis_livraison);
      const pace = g.ok_14j / 14;
      return {
        ...g,
        utilisation: g.actifs ? g.buveurs / g.actifs : null,
        par_membre_mois: g.actifs ? (g.ok / g.actifs) * (30 / days) : null,
        taux_refus: g.ok + g.refused ? g.refused / (g.ok + g.refused) : null,
        stock: capacity == null ? null : { capacite: capacity, restant: remaining, jours: pace > 0 ? Math.floor(remaining / pace) : null },
      };
    });
    const byDay = Object.fromEntries(dailyRows.map((d) => [d.day, d]));
    const daily = Array.from({ length: days }, (_, i) => {
      const day = R.addDays(from, i);
      return { day, ok: byDay[day]?.ok || 0, refused: byDay[day]?.refused || 0 };
    });
    const sum = (k) => gyms.reduce((a, g) => a + (g[k] || 0), 0);
    const site = await siteStats(sql, { days, from, fromTs, prevTs });
    return {
      period: { days, from, to: today },
      totals: { ...tot, inscrits: sum("inscrits"), actifs: sum("actifs"), buveurs: sum("buveurs"), jamais: sum("jamais"), expirent: sum("expirent"), expires_30j: sum("expires_30j") },
      daily, heatmap, refusals, gyms, expiring, idle, site,
    };
  });

  // ── Salles ─────────────────────────────────────────────
  route("GET", "/admin/gyms", async ({ req }) => {
    const { sql } = await adminCtx(req);
    const gyms = await sql`
      SELECT g.*, (SELECT json_agg(json_build_object('id', u.id, 'email', u.email, 'name', u.name))
                   FROM gym_users u WHERE u.gym_id = g.id) AS users,
             (SELECT row_to_json(c) FROM (SELECT version, signer_name, signed_at FROM contract_signatures
                WHERE gym_id = g.id ORDER BY signed_at DESC LIMIT 1) c) AS signature
      FROM gyms g ORDER BY g.name`;
    return { gyms };
  });

  route("POST", "/admin/gyms", async ({ req, body }) => {
    const { sql } = await adminCtx(req);
    const v = pick(body, GYM_FIELDS);
    if (!v.name) fail(400, "Nom de la salle obligatoire.");
    const keys = Object.keys(v);
    const [gym] = await sql(`INSERT INTO gyms (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      keys.map((k) => v[k]));
    if (body.user) await upsertGymUser(sql, gym.id, body.user);
    return { gym };
  });

  route("PATCH", "/admin/gyms/:id", async ({ req, body, params }) => {
    const { sql } = await adminCtx(req);
    if (!uuidOk(params.id)) fail(404, "Salle introuvable.");
    return { gym: await updateRow(sql, "gyms", params.id, pick(body, GYM_FIELDS)) };
  });

  route("DELETE", "/admin/gyms/:id", async ({ req, params }) => {
    const { sql } = await adminCtx(req);
    const r = uuidOk(params.id) ? await sql`DELETE FROM gyms WHERE id = ${params.id} RETURNING id` : [];
    if (!r.length) fail(404, "Salle introuvable.");
    return { ok: true };
  });

  // Accès gérant : crée ou réinitialise l'email / mot de passe fournis par VOLT.
  async function upsertGymUser(sql, gymId, u) {
    const email = String(u.email || "").trim().toLowerCase();
    if (!emailOk(email)) fail(400, "Email du gérant invalide.");
    if (!passwordOk(u.password)) fail(400, "Mot de passe : 10 caractères minimum.");
    const [other] = await sql`SELECT gym_id, role FROM gym_users WHERE email = ${email}`;
    if (other && (other.role !== "gym" || other.gym_id !== gymId)) fail(409, "Cet email est déjà utilisé.");
    await sql`
      INSERT INTO gym_users (gym_id, role, email, password_hash, name)
      VALUES (${gymId}, 'gym', ${email}, ${await bcrypt.hash(u.password, 12)}, ${u.name || null})
      ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = COALESCE(EXCLUDED.name, gym_users.name)`;
  }

  route("POST", "/admin/gyms/:id/user", async ({ req, body, params }) => {
    const { sql } = await adminCtx(req);
    if (!uuidOk(params.id)) fail(404, "Salle introuvable.");
    await upsertGymUser(sql, params.id, body);
    return { ok: true };
  });

  // ── Contrat ────────────────────────────────────────────
  route("GET", "/admin/contract-versions", async ({ req }) => {
    const { sql } = await adminCtx(req);
    return { versions: await sql`SELECT version, sha256, is_current, created_at FROM contract_versions ORDER BY created_at DESC` };
  });

  // Publie une version : l'empreinte est calculée ici sur le texte exact reçu.
  route("POST", "/admin/contract-versions", async ({ req, body }) => {
    const { sql } = await adminCtx(req);
    const version = String(body.version || "").trim();
    if (!/^\d+(\.\d+)*$/.test(version) || !body.text) fail(400, "Version (ex. 2.0) et texte obligatoires.");
    const hash = sha256(String(body.text));
    await sql.transaction([
      sql`UPDATE contract_versions SET is_current = false WHERE is_current`,
      sql`INSERT INTO contract_versions (version, text, sha256, is_current) VALUES (${version}, ${body.text}, ${hash}, true)
          ON CONFLICT (version) DO UPDATE SET text = EXCLUDED.text, sha256 = EXCLUDED.sha256, is_current = true`,
    ]);
    return { version, sha256: hash };
  });

  // ── Stations ───────────────────────────────────────────
  route("GET", "/admin/stations", async ({ req, query }) => {
    const { sql } = await adminCtx(req);
    const gymId = uuidOk(query.gym_id) ? query.gym_id : null;
    const stations = await sql`
      SELECT s.id, s.gym_id, g.name AS gym, s.name, s.location, s.installed_on::text AS installed_on, s.last_heartbeat,
             s.relay_ok, s.app_version, s.serve_signal, s.battery, s.queue_len, (s.tablet_token_hash IS NOT NULL) AS provisioned,
             s.next_maintenance_on::text AS next_maintenance_on, s.next_maintenance_slot, s.next_maintenance_tech, s.next_maintenance_note, s.relay_host,
             s.blocked, s.blocked_reason, s.blocked_at,
             (SELECT count(*)::int FROM station_events e WHERE e.station_id = s.id AND e.level <> 'info' AND e.at > now() - interval '24 hours') AS errors_24h,
             COALESCE((SELECT json_agg(json_build_object('at', e.at, 'level', e.level, 'kind', e.kind, 'message', e.message, 'app_version', e.app_version) ORDER BY e.at DESC)
               FROM (SELECT * FROM station_events x WHERE x.station_id = s.id AND x.at > now() - interval '7 days' ORDER BY x.at DESC LIMIT 15) e), '[]') AS recent_events,
             (s.last_heartbeat > now() - interval '2 minutes') AS online,
             (SELECT max(done_on)::text FROM maintenances m WHERE m.station_id = s.id AND m.type = 'Semestriel') AS last_semestriel,
             COALESCE((SELECT json_agg(json_build_object('id', m.id, 'done_on', m.done_on::text, 'type', m.type, 'technician', m.technician, 'note', m.note) ORDER BY m.done_on)
               FROM maintenances m WHERE m.station_id = s.id), '[]') AS maintenances
      FROM stations s JOIN gyms g ON g.id = s.gym_id
      WHERE ${gymId}::uuid IS NULL OR s.gym_id = ${gymId}::uuid ORDER BY g.name, s.name`;
    return {
      stations: stations.map((s) => ({ ...s, online: !!s.online,
        next_maintenance: R.nextMaintenance({ planned_on: s.next_maintenance_on, last_semestriel: s.last_semestriel, installed_on: s.installed_on }) })),
    };
  });

  route("POST", "/admin/stations", async ({ req, body }) => {
    const { sql } = await adminCtx(req);
    if (!uuidOk(body.gym_id) || !body.name) fail(400, "Salle et nom de station obligatoires.");
    const [s] = await sql`
      INSERT INTO stations (gym_id, name, location, installed_on, serve_signal, relay_host)
      VALUES (${body.gym_id}, ${body.name}, ${body.location || null}, ${M.parseDate(body.installed_on) || R.todayZurich()}, ${!!body.serve_signal}, ${body.relay_host || null})
      RETURNING id, gym_id, name, location, relay_host, installed_on::text AS installed_on`;
    return { station: s };
  });

  route("PATCH", "/admin/stations/:id", async ({ req, body, params }) => {
    const { sql } = await adminCtx(req);
    if (!uuidOk(params.id)) fail(404, "Station introuvable.");
    const v = pick(body, STATION_FIELDS);
    if ("installed_on" in v && v.installed_on && !M.parseDate(v.installed_on)) fail(400, "Date d'installation invalide.");
    if ("blocked" in v) {
      // Blocage / déblocage : l'horodatage suit l'état, le motif est vidé au déblocage.
      v.blocked = v.blocked === true;
      v.blocked_reason = v.blocked && v.blocked_reason ? String(v.blocked_reason).trim().slice(0, 200) || null : null;
      v.blocked_at = v.blocked ? new Date().toISOString() : null;
    } else delete v.blocked_reason;
    const { tablet_token_hash, ...station } = await updateRow(sql, "stations", params.id, v);
    return { station };
  });

  route("DELETE", "/admin/stations/:id", async ({ req, params }) => {
    const { sql } = await adminCtx(req);
    const r = uuidOk(params.id) ? await sql`DELETE FROM stations WHERE id = ${params.id} RETURNING id` : [];
    if (!r.length) fail(404, "Station introuvable.");
    return { ok: true };
  });

  // Provisionne (ou fait tourner) le jeton de la tablette. Le jeton en clair n'est renvoyé qu'une fois (QR).
  route("POST", "/admin/stations/:id/token", async ({ req, params }) => {
    const { sql } = await adminCtx(req);
    if (!uuidOk(params.id)) fail(404, "Station introuvable.");
    const token = randomToken("vt_");
    const r = await sql`UPDATE stations SET tablet_token_hash = ${sha256(token)} WHERE id = ${params.id} RETURNING id, name`;
    if (!r.length) fail(404, "Station introuvable.");
    const api = `https://${req.headers["x-forwarded-host"] || req.headers.host}/api/v1`;
    return { token, provisioning: JSON.stringify({ v: 1, api, station_id: r[0].id, token }) };
  });

  // ── Membres (tout le réseau) ───────────────────────────
  route("GET", "/admin/members", async ({ req, query }) => {
    const { sql, today } = await adminCtx(req);
    const params = [];
    const where = [];
    if (uuidOk(query.gym_id)) { params.push(query.gym_id); where.push(`m.gym_id = $${params.length}`); }
    if (query.q) {
      params.push(`%${String(query.q).trim()}%`);
      where.push(`(m.prenom || ' ' || m.nom ILIKE $${params.length} OR m.email ILIKE $${params.length} OR m.code_acces ILIKE $${params.length})`);
    }
    const rows = await sql(`SELECT ${M.MEMBER_SELECT}, g.name AS gym FROM members m JOIN gyms g ON g.id = m.gym_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY m.nom, m.prenom LIMIT 1000`, params);
    return { members: rows.map((m) => ({ ...M.serialize(m, today), gym_id: m.gym_id, gym: m.gym })) };
  });

  route("POST", "/admin/members", async ({ req, body }) => {
    const { sql, today } = await adminCtx(req);
    if (!uuidOk(body.gym_id)) fail(400, "Choisis la salle du membre.");
    const [gym] = await sql`SELECT id, name FROM gyms WHERE id = ${body.gym_id}`;
    if (!gym) fail(404, "Salle introuvable.");
    const { value: v, error } = M.validateNew(body);
    if (error) fail(400, error);
    const [dup] = await sql`SELECT 1 FROM members WHERE gym_id = ${gym.id} AND code_acces = ${v.code_acces}`;
    if (dup) fail(409, "Ce n° d'accès est déjà attribué à un autre membre.");
    const [row] = await sql`
      INSERT INTO members (gym_id, prenom, nom, telephone, email, naissance, ref_salle, code_acces, debut, fin, duree, notes)
      VALUES (${gym.id}, ${v.prenom}, ${v.nom}, ${v.telephone}, ${v.email}, ${v.naissance}, ${v.ref_salle}, ${v.code_acces},
              ${v.debut}, ${v.fin}, ${v.duree}, ${v.notes})
      RETURNING id`;
    const [m] = await sql(`SELECT ${M.MEMBER_SELECT} FROM members m WHERE m.id = $1`, [row.id]);
    const sent = await mail.sendWelcome(m, gym.name);
    if (sent.ok) await sql`UPDATE members SET welcome_sent_at = now() WHERE id = ${row.id}`;
    return { member: { ...M.serialize(m, today), gym_id: gym.id, gym: gym.name }, welcome_sent: sent.ok };
  });

  route("PATCH", "/admin/members/:id", async ({ req, body, params }) => {
    const { sql, today } = await adminCtx(req);
    if (!uuidOk(params.id)) fail(404, "Membre introuvable.");
    const [cur] = await sql(`SELECT ${M.MEMBER_SELECT} FROM members m WHERE m.id = $1`, [params.id]);
    if (!cur) fail(404, "Membre introuvable.");
    const { value: v, error } = M.applyPatch(cur, body, today);
    if (error) fail(400, error);
    const [dup] = await sql`SELECT 1 FROM members WHERE gym_id = ${cur.gym_id} AND code_acces = ${v.code_acces} AND id <> ${cur.id}`;
    if (dup) fail(409, "Ce n° d'accès est déjà attribué à un autre membre.");
    await sql`
      UPDATE members SET prenom = ${v.prenom}, nom = ${v.nom}, telephone = ${v.telephone}, email = ${v.email},
        naissance = ${v.naissance}, ref_salle = ${v.ref_salle}, code_acces = ${v.code_acces}, notes = ${v.notes},
        debut = ${v.debut}, fin = ${v.fin}, duree = ${v.duree}, statut = ${v.statut}, reprise = ${v.reprise},
        prolonger = ${v.prolonger}, motif = ${v.motif}, pause_debut = ${v.pause_debut}, pause_ext_applied = ${v.pause_ext_applied},
        updated_at = now()
      WHERE id = ${cur.id}`;
    const [m] = await sql(`SELECT ${M.MEMBER_SELECT} FROM members m WHERE m.id = $1`, [cur.id]);
    return { member: M.serialize(m, today) };
  });

  route("DELETE", "/admin/members/:id", async ({ req, params }) => {
    const { sql } = await adminCtx(req);
    const r = uuidOk(params.id) ? await sql`DELETE FROM members WHERE id = ${params.id} RETURNING id` : [];
    if (!r.length) fail(404, "Membre introuvable.");
    return { ok: true };
  });

  // ── Livraisons ─────────────────────────────────────────
  route("GET", "/admin/deliveries", async ({ req, query }) => {
    const { sql, today } = await adminCtx(req);
    const gymId = uuidOk(query.gym_id) ? query.gym_id : null;
    const rows = await sql`
      SELECT d.id, d.gym_id, g.name AS gym, d.delivered_on::text AS delivered_on, d.stock_days, d.note, d.created_at,
             COALESCE((SELECT json_agg(json_build_object('product', i.product, 'qty', i.qty)) FROM delivery_items i
                       WHERE i.delivery_id = d.id), '[]') AS items
      FROM deliveries d JOIN gyms g ON g.id = d.gym_id
      WHERE ${gymId}::uuid IS NULL OR d.gym_id = ${gymId}::uuid
      ORDER BY d.delivered_on DESC, d.created_at DESC`;
    // Statut : seule la dernière livraison de chaque salle est « à livrer » / « planifiée », les autres « OK ».
    const seen = new Set();
    return {
      deliveries: rows.map((d) => {
        const latest = !seen.has(d.gym_id);
        seen.add(d.gym_id);
        const s = R.deliveryStatus(d.delivered_on, d.stock_days, today);
        return { ...d, next_on: s.next, days_left: s.left, status: latest ? s.status : "ok" };
      }),
    };
  });

  const parseItems = (raw) => (Array.isArray(raw) ? raw : [])
    .map((i) => ({ product: String(i.product || "").trim().slice(0, 80), qty: Math.round(Number(i.qty)) }))
    .filter((i) => i.product && i.qty > 0);

  // Modification d'une livraison : champs partiels ; si « items » est fourni, la liste remplace l'ancienne (en une seule requête).
  route("PATCH", "/admin/deliveries/:id", async ({ req, body, params }) => {
    const { sql } = await adminCtx(req);
    if (!uuidOk(params.id)) fail(404, "Livraison introuvable.");
    const [cur] = await sql`SELECT id, delivered_on::text AS delivered_on, stock_days, note FROM deliveries WHERE id = ${params.id}`;
    if (!cur) fail(404, "Livraison introuvable.");
    const day = "delivered_on" in body ? M.parseDate(body.delivered_on) : cur.delivered_on;
    const stock = "stock_days" in body ? Number(body.stock_days) : cur.stock_days;
    const note = "note" in body ? body.note || null : cur.note;
    const items = "items" in body ? parseItems(body.items) : null;
    if (!day) fail(400, "Date de livraison invalide.");
    if (!(stock > 0 && stock <= 365)) fail(400, "Nombre de jours de stock invalide.");
    if (items && !items.length) fail(400, "Indique au moins un produit livré.");
    await sql`UPDATE deliveries SET delivered_on = ${day}, stock_days = ${Math.round(stock)}, note = ${note} WHERE id = ${cur.id}`;
    if (items) {
      await sql(`WITH del AS (DELETE FROM delivery_items WHERE delivery_id = $1::uuid)
                 INSERT INTO delivery_items (delivery_id, product, qty) SELECT $1::uuid, * FROM unnest($2::text[], $3::int[])`,
        [cur.id, items.map((i) => i.product), items.map((i) => i.qty)]);
    }
    return { ok: true, id: cur.id };
  });

  route("DELETE", "/admin/deliveries/:id", async ({ req, params }) => {
    const { sql } = await adminCtx(req);
    const r = uuidOk(params.id) ? await sql`DELETE FROM deliveries WHERE id = ${params.id} RETURNING id` : [];
    if (!r.length) fail(404, "Livraison introuvable.");
    return { ok: true };
  });

  route("POST", "/admin/deliveries", async ({ req, body }) => {
    const { sql } = await adminCtx(req);
    const day = M.parseDate(body.delivered_on);
    const stock = Number(body.stock_days);
    const items = parseItems(body.items);
    if (!uuidOk(body.gym_id) || !day) fail(400, "Salle et date de livraison obligatoires.");
    if (!(stock > 0 && stock <= 365)) fail(400, "Nombre de jours de stock invalide.");
    if (!items.length) fail(400, "Indique au moins un produit livré.");
    const [d] = await sql`INSERT INTO deliveries (gym_id, delivered_on, stock_days, note)
                          VALUES (${body.gym_id}, ${day}, ${Math.round(stock)}, ${body.note || null}) RETURNING id`;
    await sql(`INSERT INTO delivery_items (delivery_id, product, qty) SELECT $1::uuid, * FROM unnest($2::text[], $3::int[])`,
      [d.id, items.map((i) => i.product), items.map((i) => i.qty)]);
    return { id: d.id };
  });

  // ── Entretien ──────────────────────────────────────────
  route("GET", "/admin/maintenances", async ({ req, query }) => {
    const { sql } = await adminCtx(req);
    const stationId = uuidOk(query.station_id) ? query.station_id : null;
    return {
      maintenances: await sql`
        SELECT m.id, m.station_id, s.name AS station, g.name AS gym, m.done_on::text AS done_on, m.type, m.technician, m.note
        FROM maintenances m JOIN stations s ON s.id = m.station_id JOIN gyms g ON g.id = s.gym_id
        WHERE ${stationId}::uuid IS NULL OR m.station_id = ${stationId}::uuid ORDER BY m.done_on DESC`,
    };
  });

  route("POST", "/admin/maintenances", async ({ req, body }) => {
    const { sql } = await adminCtx(req);
    const day = M.parseDate(body.done_on);
    if (!uuidOk(body.station_id) || !day || !MAINT_TYPES.includes(body.type)) fail(400, "Station, date et type (Semestriel / Intervention / Installation) obligatoires.");
    const [m] = await sql`INSERT INTO maintenances (station_id, done_on, type, technician, note)
                          VALUES (${body.station_id}, ${day}, ${body.type}, ${body.technician || null}, ${body.note || null}) RETURNING id`;
    // Un entretien semestriel réalisé solde la planification en cours.
    if (body.type === "Semestriel") {
      await sql`UPDATE stations SET next_maintenance_on = NULL, next_maintenance_slot = NULL
                WHERE id = ${body.station_id} AND next_maintenance_on <= ${R.addDays(day, 30)}::date`;
    }
    return { id: m.id };
  });

  route("PATCH", "/admin/maintenances/:id", async ({ req, body, params }) => {
    const { sql } = await adminCtx(req);
    if (!uuidOk(params.id)) fail(404, "Entretien introuvable.");
    const v = {};
    if ("done_on" in body) { const day = M.parseDate(body.done_on); if (!day) fail(400, "Date d'entretien invalide."); v.done_on = day; }
    if ("type" in body) { if (!MAINT_TYPES.includes(body.type)) fail(400, "Type d'entretien invalide."); v.type = body.type; }
    if ("technician" in body) v.technician = body.technician ? String(body.technician).trim().slice(0, 120) || null : null;
    if ("note" in body) v.note = body.note ? String(body.note).slice(0, 1000) : null;
    await updateRow(sql, "maintenances", params.id, v);
    return { ok: true, id: params.id };
  });

  route("DELETE", "/admin/maintenances/:id", async ({ req, params }) => {
    const { sql } = await adminCtx(req);
    const r = uuidOk(params.id) ? await sql`DELETE FROM maintenances WHERE id = ${params.id} RETURNING id` : [];
    if (!r.length) fail(404, "Entretien introuvable.");
    return { ok: true };
  });

  route("POST", "/admin/maintenances/plan", async ({ req, body }) => {
    const { sql } = await adminCtx(req);
    const day = body.date ? M.parseDate(body.date) : null;
    if (!uuidOk(body.station_id) || day === undefined) fail(400, "Station et date valides obligatoires.");
    const r = await sql`UPDATE stations SET next_maintenance_on = ${day}, next_maintenance_slot = ${day ? body.slot || null : null},
                          next_maintenance_tech = ${day ? body.technician || null : null}, next_maintenance_note = ${day ? body.note || null : null}
                        WHERE id = ${body.station_id} RETURNING id`;
    if (!r.length) fail(404, "Station introuvable.");
    return { ok: true };
  });

  // ── Passages ───────────────────────────────────────────
  route("GET", "/admin/passages", async ({ req, query }) => {
    const { sql } = await adminCtx(req);
    return { passages: await queryPassages(sql, uuidOk(query.gym_id) ? query.gym_id : null, query, Math.min(Number(query.limit) || 2000, 20000)) };
  });

  route("DELETE", "/admin/passages/:id", async ({ req, params }) => {
    const { sql } = await adminCtx(req);
    const r = uuidOk(params.id) ? await sql`DELETE FROM passages WHERE id = ${params.id} RETURNING id` : [];
    if (!r.length) fail(404, "Passage introuvable.");
    return { ok: true };
  });
};
