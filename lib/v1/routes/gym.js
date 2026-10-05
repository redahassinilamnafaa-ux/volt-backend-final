// Routes /gym/* — Espace fitness. Toutes filtrées par le gym_id de la session.
const crypto = require("crypto");
const db = require("../db");
const R = require("../rules");
const M = require("../members");
const { fail, clientIp, sendCsv } = require("../http");
const { requireUser, sha256 } = require("../auth");
const { limit } = require("../ratelimit");
const mail = require("../mail");
const { contractPdf } = require("../pdf");

const ANOMALY_TYPES = ["Fuite", "Goût / odeur", "Aspect de la boisson", "Panne / ne distribue pas", "Tablette / badge", "Stockage / poche", "Autre"];
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

const monthStartSql = `(date_trunc('month', now() AT TIME ZONE 'Europe/Zurich') AT TIME ZONE 'Europe/Zurich')`;

async function loadGym(sql, gymId) {
  const [g] = await sql`SELECT * FROM gyms WHERE id = ${gymId}`;
  if (!g) fail(404, "Salle introuvable.");
  return g;
}

async function listMembers(sql, gymId, id = null) {
  return sql(`
    SELECT ${M.MEMBER_SELECT},
      (SELECT max(p.ts) FROM passages p WHERE p.member_id = m.id AND p.result = 'ok') AS last_ok,
      (SELECT count(*)::int FROM passages p WHERE p.member_id = m.id AND p.result = 'ok' AND p.ts >= ${monthStartSql}) AS month_count
    FROM members m WHERE m.gym_id = $1 ${id ? "AND m.id = $2" : ""}
    ORDER BY m.nom, m.prenom`, id ? [gymId, id] : [gymId]);
}

async function getMember(sql, gymId, id) {
  const [m] = await listMembers(sql, gymId, id);
  if (!m) fail(404, "Membre introuvable.");
  return m;
}

const uuidOk = (s) => /^[0-9a-f-]{36}$/i.test(s || "");

// Filtres communs passages (JSON et CSV).
async function queryPassages(sql, gymId, q, max) {
  const where = ["p.gym_id = $1"];
  const params = [gymId];
  const add = (cond, val) => { params.push(val); where.push(cond.replace("?", `$${params.length}`)); };
  const from = M.parseDate(q.from), to = M.parseDate(q.to);
  if (from) add("p.ts >= (?::date AT TIME ZONE 'Europe/Zurich')", from);
  if (to) add("p.ts < ((?::date + 1) AT TIME ZONE 'Europe/Zurich')", to);
  if (q.result === "refus") where.push("p.result NOT IN ('ok','relais')");
  else if (R.LOG_RESULTS.includes(q.result)) add("p.result = ?", q.result);
  if (q.station_id && uuidOk(q.station_id)) add("p.station_id = ?", q.station_id);
  if (q.member_id && uuidOk(q.member_id)) add("p.member_id = ?", q.member_id);
  if (q.q) {
    params.push(`%${String(q.q).replace(/[\s-]/g, "").toUpperCase()}%`, `%${String(q.q).trim()}%`);
    where.push(`(p.code LIKE $${params.length - 1} OR (m.prenom || ' ' || m.nom) ILIKE $${params.length})`);
  }
  const order = q.sort === "asc" ? "ASC" : "DESC";
  return sql(`
    SELECT p.id, p.ts, p.result, p.code, p.offline, p.station_id, s.name AS station, p.member_id, m.prenom, m.nom
    FROM passages p LEFT JOIN members m ON m.id = p.member_id LEFT JOIN stations s ON s.id = p.station_id
    WHERE ${where.join(" AND ")} ORDER BY p.ts ${order} LIMIT ${max}`, params);
}

const fmtTs = (ts) => new Date(ts).toLocaleString("fr-CH", { timeZone: R.TZ });

async function currentContract(sql) {
  const [v] = await sql`SELECT version, text, sha256 FROM contract_versions WHERE is_current`;
  return v || null;
}

module.exports = function register(route) {
  const gymCtx = (req) => {
    const s = requireUser(req, "gym");
    return { s, gymId: s.gym_id, sql: db(), today: R.todayZurich() };
  };

  // ── Salle et contrat ───────────────────────────────────
  route("GET", "/gym/me", async ({ req }) => {
    const { s, gymId, sql } = gymCtx(req);
    const gym = await loadGym(sql, gymId);
    const [user] = await sql`SELECT id, email, name FROM gym_users WHERE id = ${s.uid}`;
    const cur = await currentContract(sql);
    const [sig] = await sql`SELECT id, version, signer_name, signer_role, signed_at FROM contract_signatures
                            WHERE gym_id = ${gymId} ORDER BY signed_at DESC LIMIT 1`;
    return {
      gym, user,
      contract: { current_version: cur?.version || null, signature: sig || null, needs_signature: !!cur && sig?.version !== cur.version },
    };
  });

  route("GET", "/gym/contract", async ({ req }) => {
    const { sql } = gymCtx(req);
    const cur = await currentContract(sql);
    if (!cur) fail(404, "Aucun contrat publié.");
    return cur;
  });

  route("POST", "/gym/contract/otp", async ({ req, body }) => {
    const { s, gymId, sql } = gymCtx(req);
    const name = String(body.name || "").trim().slice(0, 120), role = String(body.role || "").trim().slice(0, 120);
    if (!name || !role) fail(400, "Nom et fonction obligatoires.");
    if (body.authorized === false || body.accepted === false) fail(400, "Coche les deux cases pour continuer.");
    const cur = await currentContract(sql);
    if (!cur || body.version !== cur.version) fail(409, "Une nouvelle version du contrat est disponible. Recharge la page.");
    await limit(`otp:${gymId}`, 5, 3600, "Trop de codes demandés. Réessaie dans une heure.");
    const gym = await loadGym(sql, gymId);
    const [user] = await sql`SELECT id, email FROM gym_users WHERE id = ${s.uid}`;
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
    await sql`
      INSERT INTO contract_otps (gym_id, user_id, code_hash, signer_name, signer_role, version, attempts, expires_at)
      VALUES (${gymId}, ${user.id}, ${sha256(gymId + ":" + code)}, ${name}, ${role}, ${cur.version}, 0, now() + interval '10 minutes')
      ON CONFLICT (gym_id) DO UPDATE SET user_id = EXCLUDED.user_id, code_hash = EXCLUDED.code_hash, signer_name = EXCLUDED.signer_name,
        signer_role = EXCLUDED.signer_role, version = EXCLUDED.version, attempts = 0, expires_at = EXCLUDED.expires_at`;
    const r = await mail.sendContractOtp(user.email, code, gym);
    if (!r.ok) fail(502, "L'email n'a pas pu être envoyé. Réessaie.");
    const [local, domain] = user.email.split("@");
    return { dest: `${local.slice(0, 2)}${"•".repeat(Math.max(1, local.length - 2))}@${domain}` };
  });

  route("POST", "/gym/contract/sign", async ({ req, body }) => {
    const { gymId, sql } = gymCtx(req);
    const [otp] = await sql`SELECT * FROM contract_otps WHERE gym_id = ${gymId}`;
    if (!otp || new Date(otp.expires_at) < new Date()) fail(400, "Code expiré. Demande un nouveau code.");
    if (otp.attempts >= 5) fail(429, "Trop d'essais. Demande un nouveau code.");
    if (otp.code_hash !== sha256(gymId + ":" + String(body.code || "").trim())) {
      await sql`UPDATE contract_otps SET attempts = attempts + 1 WHERE gym_id = ${gymId}`;
      fail(400, `Code incorrect (${4 - otp.attempts} essai(s) restant(s)).`);
    }
    const cur = await currentContract(sql);
    if (!cur || body.version !== cur.version || otp.version !== cur.version) fail(409, "Une nouvelle version du contrat est disponible. Recharge la page.");
    if (body.hash && String(body.hash).toLowerCase() !== cur.sha256) fail(409, "Le texte affiché ne correspond pas à la version officielle. Recharge la page.");
    const [sig] = await sql`
      INSERT INTO contract_signatures (gym_id, version, signer_name, signer_role, ip, user_agent, text_sha256)
      VALUES (${gymId}, ${cur.version}, ${otp.signer_name}, ${otp.signer_role}, ${clientIp(req)},
              ${String(req.headers["user-agent"] || "").slice(0, 400)}, ${cur.sha256})
      RETURNING id, version, signer_name, signer_role, signed_at, host(ip) AS ip, user_agent, text_sha256`;
    await sql.transaction([
      sql`DELETE FROM contract_otps WHERE gym_id = ${gymId}`,
      sql`UPDATE gyms SET contract_status = 'signe' WHERE id = ${gymId}`,
    ]);
    const gym = await loadGym(sql, gymId);
    const pdf = await contractPdf({ gym, version: cur.version, html: cur.text, signature: sig });
    const [user] = await sql`SELECT email FROM gym_users WHERE id = ${otp.user_id}`;
    const dests = [...new Set([gym.contact_email, user?.email, mail.VOLT_EMAIL()].filter(Boolean))];
    for (const to of dests) await mail.sendContractSigned(to, gym, sig, pdf);
    return { signature: sig };
  });

  route("GET", "/gym/contract/pdf", async ({ req, res }) => {
    const { gymId, sql } = gymCtx(req);
    const [sig] = await sql`SELECT id, version, signer_name, signer_role, signed_at, host(ip) AS ip, user_agent, text_sha256
                            FROM contract_signatures WHERE gym_id = ${gymId} ORDER BY signed_at DESC LIMIT 1`;
    if (!sig) fail(404, "Aucun contrat signé.");
    const [v] = await sql`SELECT text FROM contract_versions WHERE version = ${sig.version}`;
    const pdf = await contractPdf({ gym: await loadGym(sql, gymId), version: sig.version, html: v?.text || "", signature: sig });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="contrat-volt-${sig.version}.pdf"`);
    res.status(200).send(Buffer.from(pdf));
  });

  // ── Membres ────────────────────────────────────────────
  route("GET", "/gym/members", async ({ req }) => {
    const { gymId, sql, today } = gymCtx(req);
    return { members: (await listMembers(sql, gymId)).map((m) => M.serialize(m, today)) };
  });

  route("POST", "/gym/members", async ({ req, body }) => {
    const { gymId, sql, today } = gymCtx(req);
    const { value: v, error } = M.validateNew(body);
    if (error) fail(400, error);
    const [dup] = await sql`SELECT 1 FROM members WHERE gym_id = ${gymId} AND code_acces = ${v.code_acces}`;
    if (dup) fail(409, "Ce n° d'accès est déjà attribué à un autre membre.");
    const [row] = await sql`
      INSERT INTO members (gym_id, prenom, nom, telephone, email, naissance, ref_salle, code_acces, debut, fin, duree, notes)
      VALUES (${gymId}, ${v.prenom}, ${v.nom}, ${v.telephone}, ${v.email}, ${v.naissance}, ${v.ref_salle}, ${v.code_acces},
              ${v.debut}, ${v.fin}, ${v.duree}, ${v.notes})
      RETURNING id`;
    const gym = await loadGym(sql, gymId);
    const m = await getMember(sql, gymId, row.id);
    const sent = await mail.sendWelcome(m, gym.name);
    if (sent.ok) await sql`UPDATE members SET welcome_sent_at = now() WHERE id = ${row.id}`;
    return { member: M.serialize({ ...m, welcome_sent_at: sent.ok ? new Date() : null }, today), welcome_sent: sent.ok };
  });

  route("PATCH", "/gym/members/:id", async ({ req, body, params }) => {
    const { gymId, sql, today } = gymCtx(req);
    if (!uuidOk(params.id)) fail(404, "Membre introuvable.");
    const cur = await getMember(sql, gymId, params.id);
    const { value: v, error } = M.applyPatch(cur, body, today);
    if (error) fail(400, error);
    if (v.code_acces !== cur.code_acces) {
      const [dup] = await sql`SELECT 1 FROM members WHERE gym_id = ${gymId} AND code_acces = ${v.code_acces} AND id <> ${cur.id}`;
      if (dup) fail(409, "Ce n° d'accès est déjà attribué à un autre membre.");
    }
    await sql`
      UPDATE members SET prenom = ${v.prenom}, nom = ${v.nom}, telephone = ${v.telephone}, email = ${v.email},
        naissance = ${v.naissance}, ref_salle = ${v.ref_salle}, code_acces = ${v.code_acces}, notes = ${v.notes},
        debut = ${v.debut}, fin = ${v.fin}, duree = ${v.duree}, statut = ${v.statut}, reprise = ${v.reprise},
        prolonger = ${v.prolonger}, motif = ${v.motif}, pause_debut = ${v.pause_debut}, pause_ext_applied = ${v.pause_ext_applied},
        updated_at = now()
      WHERE id = ${cur.id} AND gym_id = ${gymId}`;
    return { member: M.serialize(await getMember(sql, gymId, cur.id), today) };
  });

  route("DELETE", "/gym/members/:id", async ({ req, params }) => {
    const { gymId, sql } = gymCtx(req);
    if (!uuidOk(params.id)) fail(404, "Membre introuvable.");
    const r = await sql`DELETE FROM members WHERE id = ${params.id} AND gym_id = ${gymId} RETURNING id`;
    if (!r.length) fail(404, "Membre introuvable.");
    return { ok: true };
  });

  route("POST", "/gym/members/:id/welcome", async ({ req, params }) => {
    const { gymId, sql } = gymCtx(req);
    if (!uuidOk(params.id)) fail(404, "Membre introuvable.");
    await limit(`welcome:${params.id}`, 3, 3600, "Email déjà renvoyé récemment.");
    const m = await getMember(sql, gymId, params.id);
    const gym = await loadGym(sql, gymId);
    const r = await mail.sendWelcome(m, gym.name);
    if (!r.ok) fail(502, "L'email n'a pas pu être envoyé.");
    await sql`UPDATE members SET welcome_sent_at = now() WHERE id = ${m.id}`;
    return { ok: true };
  });

  // Import en masse : {members:[{prenom,nom,telephone,email,numero_acces,debut,fin}]}
  route("POST", "/gym/members/import", async ({ req, body }) => {
    const { gymId, sql } = gymCtx(req);
    const rows = Array.isArray(body.members) ? body.members : [];
    if (!rows.length) fail(400, "Aucun membre à importer.");
    if (rows.length > 2000) fail(400, "2000 membres maximum par import.");
    const existing = new Set((await sql`SELECT code_acces FROM members WHERE gym_id = ${gymId}`).map((r) => r.code_acces));
    const skipped = [], ok = [];
    rows.forEach((r, i) => {
      const { value, error } = M.validateNew(r);
      if (error) return skipped.push({ line: i + 1, reason: error });
      if (existing.has(value.code_acces)) return skipped.push({ line: i + 1, reason: "N° d'accès déjà attribué." });
      existing.add(value.code_acces);
      ok.push(value);
    });
    let created = [];
    if (ok.length) {
      const col = (k) => ok.map((v) => v[k]);
      created = await sql(`
        INSERT INTO members (gym_id, prenom, nom, telephone, email, naissance, code_acces, debut, fin)
        SELECT $1::uuid, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::date[], $7::text[], $8::date[], $9::date[])
        RETURNING id, gym_id, prenom, email`,
        [gymId, col("prenom"), col("nom"), col("telephone"), col("email"), col("naissance"), col("code_acces"), col("debut"), col("fin")]);
      const gym = await loadGym(sql, gymId);
      const sentIds = await mail.sendWelcomeBatch(created, gym.name);
      if (sentIds.length) await sql`UPDATE members SET welcome_sent_at = now() WHERE id = ANY(${sentIds}::uuid[])`;
    }
    return { created: created.length, skipped };
  });

  // ── Passages ───────────────────────────────────────────
  route("GET", "/gym/passages", async ({ req, query }) => {
    const { gymId, sql } = gymCtx(req);
    return { passages: await queryPassages(sql, gymId, query, 2000) };
  });

  route("GET", "/gym/passages/export.csv", async ({ req, res, query }) => {
    const { gymId, sql } = gymCtx(req);
    const rows = await queryPassages(sql, gymId, query, 200000);
    sendCsv(res, "passages-volt.csv", [["date", "membre", "numero_acces", "resultat", "station", "hors_ligne"],
      ...rows.map((p) => [fmtTs(p.ts), p.prenom ? `${p.prenom} ${p.nom}` : "", p.code, p.result, p.station || "", p.offline ? "oui" : "non"])]);
  });

  route("GET", "/gym/passages/monthly.csv", async ({ req, res }) => {
    const { gymId, sql } = gymCtx(req);
    const rows = await sql`SELECT month::text AS month, ok_count, refused_count, distinct_members
                           FROM passages_monthly WHERE gym_id = ${gymId} ORDER BY month DESC`;
    sendCsv(res, "totaux-mensuels-volt.csv", [["mois", "boissons", "refus", "membres_distincts"],
      ...rows.map((r) => [r.month.slice(0, 7), r.ok_count, r.refused_count, r.distinct_members])]);
  });

  // ── Stations ───────────────────────────────────────────
  route("GET", "/gym/stations", async ({ req }) => {
    const { gymId, sql, today } = gymCtx(req);
    const stations = await sql`
      SELECT s.id, s.name, s.location, s.installed_on::text AS installed_on, s.last_heartbeat, s.relay_ok, s.app_version,
             s.serve_signal, s.battery, s.queue_len, s.next_maintenance_on::text AS next_maintenance_on, s.next_maintenance_slot,
             (s.last_heartbeat > now() - interval '2 minutes') AS online,
             (SELECT count(*)::int FROM passages p WHERE p.station_id = s.id AND p.result = 'ok'
                AND p.ts >= (${today}::date AT TIME ZONE 'Europe/Zurich')) AS ok_today
      FROM stations s WHERE s.gym_id = ${gymId} ORDER BY s.name`;
    const maint = stations.length ? await sql`
      SELECT id, station_id, done_on::text AS done_on, type, technician, note FROM maintenances
      WHERE station_id = ANY(${stations.map((s) => s.id)}::uuid[]) ORDER BY done_on DESC` : [];
    return {
      stations: stations.map((s) => {
        const history = maint.filter((m) => m.station_id === s.id);
        const last = history.find((m) => m.type === "Semestriel");
        return {
          ...s, online: !!s.online, maintenances: history,
          next_maintenance: { date: R.nextMaintenance({ planned_on: s.next_maintenance_on, last_semestriel: last?.done_on, installed_on: s.installed_on }),
                              slot: s.next_maintenance_slot, planned: !!s.next_maintenance_on },
        };
      }),
    };
  });

  route("POST", "/gym/stations/:id/intervention", async ({ req, body, params }) => {
    const { s, gymId, sql } = gymCtx(req);
    if (!uuidOk(params.id)) fail(404, "Station introuvable.");
    const [station] = await sql`SELECT id, name FROM stations WHERE id = ${params.id} AND gym_id = ${gymId}`;
    if (!station) fail(404, "Station introuvable.");
    await limit(`intervention:${gymId}`, 10, 3600);
    const [user] = await sql`SELECT email, name FROM gym_users WHERE id = ${s.uid}`;
    const r = await mail.sendIntervention(await loadGym(sql, gymId), station, String(body.message || "").slice(0, 2000), user?.name || user?.email);
    if (!r.ok) fail(502, "La demande n'a pas pu être envoyée. Appelle VOLT.");
    return { ok: true };
  });

  // ── Autocontrôle ───────────────────────────────────────
  route("GET", "/gym/autocontrols", async ({ req, query }) => {
    const { gymId, sql, today } = gymCtx(req);
    const days = Math.min(Math.max(Number(query.days) || 30, 1), 730);
    const rows = await sql`
      SELECT a.id, a.station_id, a.day::text AS day, a.checks, a.weekly, a.visa, a.note, a.late, a.created_at,
             COALESCE(json_agg(json_build_object('id', n.id, 'type', n.type, 'description', n.description, 'saveur', n.saveur,
               'lot', n.lot, 'station_off', n.station_off, 'pouch_kept', n.pouch_kept, 'created_at', n.created_at))
               FILTER (WHERE n.id IS NOT NULL), '[]') AS anomalies
      FROM autocontrols a LEFT JOIN anomalies n ON n.autocontrol_id = a.id
      WHERE a.gym_id = ${gymId} AND a.day > ${R.addDays(today, -days)}::date
      GROUP BY a.id ORDER BY a.day DESC, a.created_at DESC`;
    return { autocontrols: rows };
  });

  route("POST", "/gym/autocontrols", async ({ req, body }) => {
    const { gymId, sql, today } = gymCtx(req);
    const day = M.parseDate(body.day) || today;
    if (day > today) fail(400, "Impossible de saisir un jour futur.");
    if (day < R.addDays(today, -7)) fail(400, "Saisie possible jusqu'à 7 jours en arrière seulement.");
    const visa = String(body.visa || "").trim().slice(0, 10);
    if (!visa) fail(400, "Visa (initiales) obligatoire.");
    const stationId = body.station_id && uuidOk(body.station_id) ? body.station_id : null;
    let station = null;
    if (stationId) {
      [station] = await sql`SELECT id, name FROM stations WHERE id = ${stationId} AND gym_id = ${gymId}`;
      if (!station) fail(404, "Station introuvable.");
    }
    const checks = body.checks && typeof body.checks === "object" ? body.checks : {};
    const a = body.anomaly;
    let photo = null;
    if (a) {
      if (!ANOMALY_TYPES.includes(a.type)) fail(400, "Type d'anomalie invalide.");
      if (!String(a.description || "").trim()) fail(400, "Le constat est obligatoire.");
      if (a.photo) {
        const m = /^data:(image\/(?:jpeg|png|webp|heic));base64,([A-Za-z0-9+/=]+)$/.exec(a.photo);
        if (!m) fail(400, "Photo invalide (JPEG, PNG ou WebP).");
        if (m[2].length * 0.75 > MAX_PHOTO_BYTES) fail(413, "Photo trop lourde (3 Mo max).");
        photo = { base64: m[2], filename: `anomalie.${m[1].split("/")[1].replace("jpeg", "jpg")}` };
      }
    } else if (!Object.keys(checks).length) {
      fail(400, "Coche les points de contrôle.");
    }

    const [existing] = await sql`
      SELECT id, checks FROM autocontrols
      WHERE gym_id = ${gymId} AND day = ${day} AND station_id IS NOT DISTINCT FROM ${stationId}`;
    let acId;
    if (existing) {
      const anomalyOnly = !Object.keys(existing.checks || {}).length;
      if (!a && !anomalyOnly) fail(409, "L'autocontrôle de ce jour est déjà saisi.");
      if (!a) {
        await sql`UPDATE autocontrols SET checks = ${JSON.stringify(checks)}::jsonb, weekly = ${!!body.weekly}, visa = ${visa},
                  note = ${body.note || null} WHERE id = ${existing.id}`;
      }
      acId = existing.id;
    } else {
      const [row] = await sql`
        INSERT INTO autocontrols (gym_id, station_id, day, checks, weekly, visa, note, late)
        VALUES (${gymId}, ${stationId}, ${day}, ${JSON.stringify(a && !Object.keys(checks).length ? {} : checks)}::jsonb,
                ${!!body.weekly}, ${visa}, ${String(body.note || "").slice(0, 2000) || null}, ${day < today})
        RETURNING id`;
      acId = row.id;
    }
    if (a) {
      await sql`
        INSERT INTO anomalies (autocontrol_id, type, description, saveur, lot, station_off, pouch_kept)
        VALUES (${acId}, ${a.type}, ${String(a.description).slice(0, 2000)}, ${a.saveur || null}, ${a.lot || null},
                ${!!a.station_off}, ${!!a.pouch_kept})`;
      await mail.sendAnomaly(await loadGym(sql, gymId), a, station, photo);
    }
    return { ok: true, id: acId, late: day < today };
  });

  route("GET", "/gym/autocontrols/export.csv", async ({ req, res }) => {
    const { gymId, sql } = gymCtx(req);
    const rows = await sql`
      SELECT a.day::text AS day, s.name AS station, a.checks, a.weekly, a.visa, a.note, a.late, a.created_at,
             n.type, n.description, n.saveur, n.lot, n.station_off, n.pouch_kept
      FROM autocontrols a LEFT JOIN stations s ON s.id = a.station_id LEFT JOIN anomalies n ON n.autocontrol_id = a.id
      WHERE a.gym_id = ${gymId} ORDER BY a.day DESC, a.created_at DESC`;
    sendCsv(res, "autocontrole-volt.csv", [
      ["jour", "station", "points_controles", "hebdomadaire", "visa", "remarque", "saisie_tardive", "saisi_le",
        "anomalie_type", "anomalie_constat", "saveur", "lot", "hors_service", "poche_conservee"],
      ...rows.map((r) => [r.day.split("-").reverse().join("."), r.station || "",
        Object.entries(r.checks || {}).filter(([, v]) => v).map(([k]) => k).join(", "),
        r.weekly ? "oui" : "non", r.visa, r.note || "", r.late ? "oui" : "non", fmtTs(r.created_at),
        r.type || "", r.description || "", r.saveur || "", r.lot || "",
        r.type ? (r.station_off ? "oui" : "non") : "", r.type ? (r.pouch_kept ? "oui" : "non") : ""]),
    ]);
  });
};

module.exports.listMembers = listMembers;
module.exports.queryPassages = queryPassages;
module.exports.ANOMALY_TYPES = ANOMALY_TYPES;
