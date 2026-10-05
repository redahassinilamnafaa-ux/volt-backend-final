// Routes /admin/* — back-office VOLT. (rôle admin). Chaque appel est journalisé (admin_audit).
const bcrypt = require("bcryptjs");
const db = require("../db");
const R = require("../rules");
const M = require("../members");
const { fail } = require("../http");
const { requireUser, sha256, randomToken } = require("../auth");
const { emailOk, passwordOk } = require("./auth");
const { queryPassages } = require("./gym");

const uuidOk = (s) => /^[0-9a-f-]{36}$/i.test(s || "");
const GYM_FIELDS = ["name", "legal_name", "ide", "address", "city", "filiale", "contact_name", "contact_email", "contact_phone", "contract_status"];
const STATION_FIELDS = ["name", "location", "installed_on", "serve_signal"];
const MAINT_TYPES = ["Semestriel", "Intervention", "Installation"];

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
             s.next_maintenance_on::text AS next_maintenance_on, s.next_maintenance_slot,
             (s.last_heartbeat > now() - interval '2 minutes') AS online,
             (SELECT max(done_on)::text FROM maintenances m WHERE m.station_id = s.id AND m.type = 'Semestriel') AS last_semestriel
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
      INSERT INTO stations (gym_id, name, location, installed_on, serve_signal)
      VALUES (${body.gym_id}, ${body.name}, ${body.location || null}, ${M.parseDate(body.installed_on) || null}, ${!!body.serve_signal})
      RETURNING id, gym_id, name, location, installed_on::text AS installed_on`;
    return { station: s };
  });

  route("PATCH", "/admin/stations/:id", async ({ req, body, params }) => {
    const { sql } = await adminCtx(req);
    if (!uuidOk(params.id)) fail(404, "Station introuvable.");
    const v = pick(body, STATION_FIELDS);
    if ("installed_on" in v && v.installed_on && !M.parseDate(v.installed_on)) fail(400, "Date d'installation invalide.");
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

  route("POST", "/admin/deliveries", async ({ req, body }) => {
    const { sql } = await adminCtx(req);
    const day = M.parseDate(body.delivered_on);
    const stock = Number(body.stock_days);
    const items = (Array.isArray(body.items) ? body.items : [])
      .map((i) => ({ product: String(i.product || "").trim().slice(0, 80), qty: Math.round(Number(i.qty)) }))
      .filter((i) => i.product && i.qty > 0);
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

  route("POST", "/admin/maintenances/plan", async ({ req, body }) => {
    const { sql } = await adminCtx(req);
    const day = body.date ? M.parseDate(body.date) : null;
    if (!uuidOk(body.station_id) || day === undefined) fail(400, "Station et date valides obligatoires.");
    const r = await sql`UPDATE stations SET next_maintenance_on = ${day}, next_maintenance_slot = ${day ? body.slot || null : null}
                        WHERE id = ${body.station_id} RETURNING id`;
    if (!r.length) fail(404, "Station introuvable.");
    return { ok: true };
  });

  // ── Passages ───────────────────────────────────────────
  route("GET", "/admin/passages", async ({ req, query }) => {
    const { sql } = await adminCtx(req);
    if (!uuidOk(query.gym_id)) fail(400, "gym_id obligatoire.");
    return { passages: await queryPassages(sql, query.gym_id, query, 2000) };
  });

  route("DELETE", "/admin/passages/:id", async ({ req, params }) => {
    const { sql } = await adminCtx(req);
    const r = uuidOk(params.id) ? await sql`DELETE FROM passages WHERE id = ${params.id} RETURNING id` : [];
    if (!r.length) fail(404, "Passage introuvable.");
    return { ok: true };
  });
};
