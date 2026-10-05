// Routes /tablet/* — une tablette = une station (jeton d'appareil).
const db = require("../db");
const R = require("../rules");
const { fail } = require("../http");
const { requireTablet } = require("../auth");
const produits = require("../../../data/v1/produits.json");

const uuidOk = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || "");

module.exports = function register(route) {
  route("POST", "/tablet/verify", async ({ req, body }) => {
    const st = await requireTablet(req);
    const sql = db();
    const now = new Date();
    const code = R.normalizeCode(body.code);
    const [member] = code ? await sql`
      SELECT id, prenom, statut, debut::text AS debut, fin::text AS fin, reprise::text AS reprise
      FROM members WHERE gym_id = ${st.gym_id} AND code_acces = ${code}` : [];
    const [last] = member ? await sql`
      SELECT max(ts) AS ts FROM passages WHERE member_id = ${member.id} AND result = 'ok'` : [];
    let d = R.authorize({ member, lastOkAt: last?.ts, now });
    const logCode = code || String(body.code || "").slice(0, 40) || "?";

    if (d.result === "ok") {
      // Insertion atomique : refuse si un autre passage 'ok' a été enregistré entre-temps (double scan).
      const [p] = await sql`
        INSERT INTO passages (gym_id, station_id, member_id, code, ts, result)
        SELECT ${st.gym_id}, ${st.id}, ${member.id}, ${code}, now(), 'ok'
        WHERE NOT EXISTS (SELECT 1 FROM passages WHERE member_id = ${member.id} AND result = 'ok'
                          AND ts > now() - make_interval(secs => ${R.COOLDOWN_S}))
        RETURNING id, ts`;
      if (p) {
        return { result: "ok", name: member.prenom, passage_id: p.id,
                 next_at: new Date(new Date(p.ts).getTime() + R.COOLDOWN_S * 1000).toISOString() };
      }
      const [again] = await sql`SELECT max(ts) AS ts FROM passages WHERE member_id = ${member.id} AND result = 'ok'`;
      d = R.authorize({ member, lastOkAt: again?.ts, now: new Date() });
    }
    await sql`INSERT INTO passages (gym_id, station_id, member_id, code, ts, result)
              VALUES (${st.gym_id}, ${st.id}, ${member?.id || null}, ${logCode}, now(), ${d.log})`;
    return { result: d.result, name: member?.prenom, wait_s: d.wait_s, reason: d.reason };
  });

  // Échec du relais : le passage n'est pas décompté.
  route("POST", "/tablet/relay-result", async ({ req, body }) => {
    const st = await requireTablet(req);
    if (!uuidOk(body.passage_id)) fail(400, "passage_id invalide.");
    const sql = db();
    if (body.ok === false) {
      await sql`UPDATE passages SET result = 'relais' WHERE id = ${body.passage_id} AND station_id = ${st.id} AND result = 'ok'`;
    }
    await sql`UPDATE stations SET relay_ok = ${body.ok !== false} WHERE id = ${st.id}`;
    return { ok: true };
  });

  // Données pour le mode hors ligne : tous les membres de la salle (la tablette recalcule le statut).
  route("GET", "/tablet/sync", async ({ req }) => {
    const st = await requireTablet(req);
    const sql = db();
    const today = R.todayZurich();
    const rows = await sql`
      SELECT m.code_acces, m.prenom, m.statut, m.debut::text AS debut, m.fin::text AS fin, m.reprise::text AS reprise,
             (SELECT max(p.ts) FROM passages p WHERE p.member_id = m.id AND p.result = 'ok') AS last_ok_ts
      FROM members m WHERE m.gym_id = ${st.gym_id} AND m.fin >= ${R.addDays(today, -1)}::date`;
    return {
      station: { id: st.id, name: st.name, gym: st.gym_name },
      members: rows.map((m) => ({
        code: m.code_acces, prenom: m.prenom, debut: m.debut, fin: m.fin, statut: m.statut, reprise: m.reprise,
        status: R.memberStatus(m, today), last_ok_ts: m.last_ok_ts,
      })),
      products: produits,
      config: { cooldown_s: R.COOLDOWN_S, offline_max_h: R.OFFLINE_MAX_H, timezone: R.TZ },
      server_time: new Date().toISOString(),
    };
  });

  // Passages hors ligne, idempotents via client_id. L'horodatage de la tablette fait foi.
  route("POST", "/tablet/passages/batch", async ({ req, body }) => {
    const st = await requireTablet(req);
    const list = Array.isArray(body.passages) ? body.passages : [];
    if (list.length > 500) fail(400, "500 passages maximum par envoi.");
    const now = Date.now();
    const rejected = [];
    const valid = [];
    for (const p of list) {
      const ts = new Date(p.ts);
      const result = R.toLogResult(p.result, p.reason);
      if (!uuidOk(p.client_id) || isNaN(ts) || !result || ts.getTime() > now + 5 * 60e3 || ts.getTime() < now - 180 * 864e5) {
        rejected.push(p.client_id || null);
        continue;
      }
      valid.push({ client_id: p.client_id, code: R.normalizeCode(p.code) || String(p.code || "?").slice(0, 40), ts: ts.toISOString(), result });
    }
    if (!valid.length) return { accepted: 0, rejected };
    const sql = db();
    const inserted = await sql(`
      INSERT INTO passages (client_id, gym_id, station_id, member_id, code, ts, result, offline)
      SELECT b.client_id, $1::uuid, $2::uuid, m.id, b.code, b.ts, b.result, true
      FROM unnest($3::uuid[], $4::text[], $5::timestamptz[], $6::text[]) AS b(client_id, code, ts, result)
      LEFT JOIN members m ON m.gym_id = $1::uuid AND m.code_acces = b.code
      ON CONFLICT (client_id) DO NOTHING
      RETURNING client_id`,
      [st.gym_id, st.id, valid.map((v) => v.client_id), valid.map((v) => v.code), valid.map((v) => v.ts), valid.map((v) => v.result)]);
    // Les doublons (déjà reçus) sont acquittés : la tablette peut vider sa file.
    return { accepted: valid.length, inserted: inserted.length, rejected };
  });

  route("POST", "/tablet/heartbeat", async ({ req, body }) => {
    const st = await requireTablet(req);
    const num = (v, max) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(max, Math.round(Number(v)))) : null);
    await db()`
      UPDATE stations SET last_heartbeat = now(), battery = ${num(body.battery, 100)},
        app_version = ${body.app_version ? String(body.app_version).slice(0, 40) : null},
        relay_ok = ${typeof body.relay_ok === "boolean" ? body.relay_ok : null}, queue_len = ${num(body.queue_len, 1e6)}
      WHERE id = ${st.id}`;
    return { ok: true, server_time: new Date().toISOString() };
  });
};
