// Test de bout en bout de l'API v1 sur un vrai Postgres en mémoire (PGlite).
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = "test-secret";
process.env.CRON_SECRET = "cron-secret-test";
process.env.DATABASE_URL_V1 = "postgres://test";

const db = require("../../lib/v1/db");
const mail = require("../../lib/v1/mail");
const handler = require("../../api/v1");

// Client Resend factice : capture les emails envoyés.
const outbox = [];
mail.__setClient({
  emails: { send: async (e) => { outbox.push(e); return { data: { id: "em_" + outbox.length } }; } },
  batch: { send: async (list) => { outbox.push(...list); return { data: { data: list.map((_, i) => ({ id: "eb_" + i })) } }; } },
});

// Adaptateur PGlite → interface du driver Neon (template tagué, sql(text, params), transaction).
async function makeSql() {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  const run = async (text, params = []) => (await pg.query(text, params)).rows;
  const sql = (strings, ...vals) => {
    if (Array.isArray(strings) && strings.raw) {
      let text = strings[0];
      vals.forEach((_, i) => { text += "$" + (i + 1) + strings[i + 1]; });
      return run(text, vals);
    }
    return run(strings, vals[0] || []);
  };
  sql.transaction = async (queries) => Promise.all(queries);
  return sql;
}

// Appel HTTP simulé.
async function call(method, path, { body, token, headers = {}, ip = "1.2.3.4" } = {}) {
  const [p, qs] = path.split("?");
  const query = Object.fromEntries(new URLSearchParams(qs || ""));
  const req = { method, url: "/api/v1" + path, query: { ...query, __path: p.replace(/^\//, "") }, body,
    headers: { "x-forwarded-for": ip, "user-agent": "node-test", host: "api.test", ...(token ? { authorization: "Bearer " + token } : {}), ...headers } };
  const res = {
    statusCode: 200, headers: {}, body: undefined, headersSent: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    send(b) { this.body = b; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; },
  };
  await handler(req, res);
  return res;
}

const ok = (r, code = 200) => { assert.equal(r.statusCode, code, JSON.stringify(r.body)); return r.body; };

test("parcours complet : setup → admin → salle → membres → tablette → autocontrôle → contrat → cron", async (t) => {
  db.__set(await makeSql());

  await t.test("setup : migrations + lien d'activation admin par email, puis activation", async () => {
    outbox.length = 0;
    const r = ok(await call("POST", "/setup"));
    assert.deepEqual(r.migrations, ["001_schema.sql"]);
    assert.match(r.admin, /lien d'activation envoyé à info@volt-energy\.ch/);
    assert.equal(outbox[0].to, "info@volt-energy.ch");
    const link = /(https:\/\/www\.volt-energy\.ch\/admin\?reset=\S+)/.exec(outbox[0].text)[1];
    // Compte non activé : aucun mot de passe ne fonctionne.
    assert.equal((await call("POST", "/auth/login", { body: { email: "info@volt-energy.ch", password: "!" } })).statusCode, 401);
    ok(await call("POST", "/auth/reset", { body: { token: decodeURIComponent(link.split("reset=")[1]), password: "motdepasse-admin" } }));
    // Relance idempotente : admin actif, plus d'email.
    outbox.length = 0;
    assert.equal(ok(await call("POST", "/setup")).admin, "actif");
    assert.equal(outbox.length, 0);
  });

  let admin, gymToken, gymId, stationId, tablet, memberId;

  await t.test("login admin et refus des mauvais identifiants", async () => {
    assert.equal((await call("POST", "/auth/login", { body: { email: "info@volt-energy.ch", password: "faux" } })).statusCode, 401);
    const r = ok(await call("POST", "/auth/login", { body: { email: "Info@volt-energy.ch", password: "motdepasse-admin" } }));
    assert.equal(r.role, "admin");
    admin = r.token;
    assert.equal((await call("GET", "/admin/gyms")).statusCode, 401);
  });

  await t.test("admin crée une salle, son gérant et une station", async () => {
    const g = ok(await call("POST", "/admin/gyms", { token: admin, body: {
      name: "Fitness Crissier", city: "Crissier", contact_email: "contact@fitness.ch",
      user: { email: "gerant@fitness.ch", password: "motdepasse-gym", name: "Marc" } } }));
    gymId = g.gym.id;
    stationId = ok(await call("POST", "/admin/stations", { token: admin, body: { gym_id: gymId, name: "Station 1", installed_on: "2026-04-10" } })).station.id;
    tablet = ok(await call("POST", "/admin/stations/" + stationId + "/token", { token: admin })).token;
    assert.match(tablet, /^vt_/);
    const login = ok(await call("POST", "/auth/login", { body: { email: "gerant@fitness.ch", password: "motdepasse-gym" } }));
    assert.equal(login.role, "gym");
    gymToken = login.token;
    // Un gérant n'accède pas à l'admin.
    assert.equal((await call("GET", "/admin/gyms", { token: gymToken })).statusCode, 403);
  });

  await t.test("gérant : création de membre + email de bienvenue, doublon refusé", async () => {
    outbox.length = 0;
    const today = require("../../lib/v1/rules").todayZurich();
    const r = ok(await call("POST", "/gym/members", { token: gymToken, body: {
      prenom: "Léa", nom: "Muller", telephone: "+41 79 123 45 67", email: "lea@mail.ch",
      numero_acces: "1002 4583 0000 0001", debut: today, duree: "1m" } }));
    memberId = r.member.id;
    assert.equal(r.member.status, "actif");
    assert.equal(r.welcome_sent, true);
    assert.match(outbox[0].text, /une boisson toutes les 15 minutes/);
    const dup = await call("POST", "/gym/members", { token: gymToken, body: {
      prenom: "Max", nom: "Bo", telephone: "+41791111111", email: "max@mail.ch", numero_acces: "1002458300000001", debut: today, duree: "1m" } });
    assert.equal(dup.statusCode, 409);
    const imp = ok(await call("POST", "/gym/members/import", { token: gymToken, body: { members: [
      { prenom: "Max", nom: "Bo", telephone: "+41791111111", email: "max@mail.ch", numero_acces: "2000000000000002", debut: today, fin: "2027-12-31" },
      { prenom: "Zoé", nom: "Ka", telephone: "+41792222222", email: "zoe@mail.ch", numero_acces: "1002458300000001", debut: today, fin: "2027-12-31" },
      { prenom: "", nom: "X", telephone: "1", email: "x", numero_acces: "1", debut: today, fin: today },
    ] } }));
    assert.equal(imp.created, 1);
    assert.equal(imp.skipped.length, 2);
    assert.equal(ok(await call("GET", "/gym/members", { token: gymToken })).members.length, 2);
  });

  let passageId;
  await t.test("tablette : ok → délai 15 min → relais KO non décompté → ok", async () => {
    assert.equal((await call("POST", "/tablet/verify", { token: "vt_faux", body: { code: "x" } })).statusCode, 401);
    const unknown = ok(await call("POST", "/tablet/verify", { token: tablet, body: { code: "9999999999" } }));
    assert.equal(unknown.result, "unknown");
    const first = ok(await call("POST", "/tablet/verify", { token: tablet, body: { code: "1002-4583-0000-0001" } }));
    assert.equal(first.result, "ok");
    assert.equal(first.name, "Léa");
    passageId = first.passage_id;
    const wait = ok(await call("POST", "/tablet/verify", { token: tablet, body: { code: "1002458300000001" } }));
    assert.equal(wait.result, "wait");
    assert.ok(wait.wait_s > 880 && wait.wait_s <= 900);
    ok(await call("POST", "/tablet/relay-result", { token: tablet, body: { passage_id: passageId, ok: false } }));
    const again = ok(await call("POST", "/tablet/verify", { token: tablet, body: { code: "1002458300000001" } }));
    assert.equal(again.result, "ok");
  });

  await t.test("tablette : membre en pause → inactive", async () => {
    const r = ok(await call("PATCH", "/gym/members/" + memberId, { token: gymToken, body: { statut: "pause", prolonger: true } }));
    assert.equal(r.member.status, "pause");
    const v = ok(await call("POST", "/tablet/verify", { token: tablet, body: { code: "1002458300000001" } }));
    assert.deepEqual([v.result, v.reason], ["inactive", "pause"]);
    ok(await call("PATCH", "/gym/members/" + memberId, { token: gymToken, body: { statut: "actif" } }));
  });

  await t.test("tablette : sync, heartbeat et file hors ligne idempotente", async () => {
    const s = ok(await call("GET", "/tablet/sync", { token: tablet }));
    assert.equal(s.config.cooldown_s, 900);
    assert.equal(s.products.saveurs.length, 6);
    const lea = s.members.find((m) => m.code === "1002458300000001");
    assert.ok(lea.last_ok_ts);
    ok(await call("POST", "/tablet/heartbeat", { token: tablet, body: { battery: 87, app_version: "1.0.0", relay_ok: true, queue_len: 2 } }));
    const batch = { passages: [
      { client_id: "11111111-1111-4111-8111-111111111111", code: "2000000000000002", ts: new Date(Date.now() - 3600e3).toISOString(), result: "ok" },
      { client_id: "22222222-2222-4222-8222-222222222222", code: "0000000000", ts: new Date(Date.now() - 3000e3).toISOString(), result: "unknown" },
      { client_id: "pas-un-uuid", code: "x", ts: "n'importe", result: "ok" },
    ] };
    const b1 = ok(await call("POST", "/tablet/passages/batch", { token: tablet, body: batch }));
    assert.deepEqual([b1.accepted, b1.inserted, b1.rejected.length], [2, 2, 1]);
    const b2 = ok(await call("POST", "/tablet/passages/batch", { token: tablet, body: batch }));
    assert.equal(b2.inserted, 0);
    const st = ok(await call("GET", "/gym/stations", { token: gymToken })).stations[0];
    assert.equal(st.online, true);
    assert.equal(st.battery, 87);
    assert.equal(st.next_maintenance.date, "2026-10-10");
  });

  await t.test("passages : filtres et export CSV", async () => {
    const all = ok(await call("GET", "/gym/passages", { token: gymToken })).passages;
    assert.equal(all.length, 7);
    const refus = ok(await call("GET", "/gym/passages?result=refus", { token: gymToken })).passages;
    assert.ok(refus.every((p) => !["ok", "relais"].includes(p.result)));
    const lea = ok(await call("GET", "/gym/passages?q=L%C3%A9a", { token: gymToken })).passages;
    assert.ok(lea.length >= 3 && lea.every((p) => p.prenom === "Léa"));
    const csv = await call("GET", "/gym/passages/export.csv", { token: gymToken });
    assert.match(csv.headers["content-type"], /text\/csv/);
    assert.match(csv.body, /^﻿date;membre;numero_acces/);
  });

  await t.test("autocontrôle : saisie, doublon, retard > 7 j refusé, anomalie → email VOLT.", async () => {
    const R = require("../../lib/v1/rules");
    const today = R.todayZurich();
    ok(await call("POST", "/gym/autocontrols", { token: gymToken, body: { checks: { proprete: true, poches: true }, visa: "MB" } }));
    assert.equal((await call("POST", "/gym/autocontrols", { token: gymToken, body: { checks: { proprete: true }, visa: "MB" } })).statusCode, 409);
    assert.equal((await call("POST", "/gym/autocontrols", { token: gymToken, body: { day: R.addDays(today, -8), checks: { a: true }, visa: "MB" } })).statusCode, 400);
    const late = ok(await call("POST", "/gym/autocontrols", { token: gymToken, body: { day: R.addDays(today, -3), checks: { a: true }, visa: "MB" } }));
    assert.equal(late.late, true);
    outbox.length = 0;
    ok(await call("POST", "/gym/autocontrols", { token: gymToken, body: { visa: "MB",
      anomaly: { type: "Fuite", description: "Goutte sous la machine", station_off: true } } }));
    assert.match(outbox[0].subject, /Anomalie/);
    const list = ok(await call("GET", "/gym/autocontrols", { token: gymToken })).autocontrols;
    assert.equal(list.find((a) => a.day === today).anomalies.length, 1);
  });

  await t.test("contrat : publication, OTP par email, mauvais code, signature, PDF", async () => {
    const text = "<h1>Contrat de partenariat</h1><p>Article 1 — Objet : stations VOLT. en salle.</p>";
    const pub = ok(await call("POST", "/admin/contract-versions", { token: admin, body: { version: "2.0", text } }));
    assert.equal(ok(await call("GET", "/gym/me", { token: gymToken })).contract.needs_signature, true);
    outbox.length = 0;
    const otp = ok(await call("POST", "/gym/contract/otp", { token: gymToken, body: { name: "Marc Dupont", role: "Gérant", version: "2.0" } }));
    assert.match(otp.dest, /^ge•+@fitness\.ch$/);
    const code = /(\d{6})/.exec(outbox[0].subject)[1];
    const bad = await call("POST", "/gym/contract/sign", { token: gymToken, body: { code: code === "000000" ? "111111" : "000000", version: "2.0" } });
    assert.equal(bad.statusCode, 400);
    outbox.length = 0;
    const sig = ok(await call("POST", "/gym/contract/sign", { token: gymToken, body: { code, version: "2.0", hash: pub.sha256 } })).signature;
    assert.equal(sig.ip, "1.2.3.4");
    assert.equal(sig.text_sha256, pub.sha256);
    assert.equal(outbox.length, 3); // contact salle, gérant, VOLT.
    assert.ok(outbox[0].attachments[0].content.length > 500);
    const me = ok(await call("GET", "/gym/me", { token: gymToken }));
    assert.equal(me.contract.needs_signature, false);
    assert.equal(me.gym.contract_status, "signe");
    const pdf = await call("GET", "/gym/contract/pdf", { token: gymToken });
    assert.equal(Buffer.from(pdf.body).subarray(0, 4).toString(), "%PDF");
  });

  await t.test("admin : réseau, livraisons, entretien, membres", async () => {
    const R = require("../../lib/v1/rules");
    ok(await call("POST", "/admin/deliveries", { token: admin, body: { gym_id: gymId, delivered_on: R.todayZurich(), stock_days: 5,
      items: [{ product: "Cassis", qty: 4 }, { product: "Multi Fruit", qty: 2 }] } }));
    const d = ok(await call("GET", "/admin/deliveries", { token: admin })).deliveries[0];
    assert.equal(d.status, "a_livrer");
    assert.equal(d.items.length, 2);
    ok(await call("POST", "/admin/maintenances/plan", { token: admin, body: { station_id: stationId, date: "2026-10-20", slot: "9h-11h" } }));
    ok(await call("POST", "/admin/maintenances", { token: admin, body: { station_id: stationId, done_on: "2026-10-20", type: "Semestriel", technician: "Reda" } }));
    const st = ok(await call("GET", "/admin/stations", { token: admin })).stations[0];
    assert.equal(st.next_maintenance, "2027-04-20");
    const net = ok(await call("GET", "/admin/network", { token: admin })).gyms[0];
    assert.equal(net.actifs, 2);
    assert.ok(net.alerts.some((a) => /Livraison/.test(a)));
    const m = ok(await call("GET", "/admin/members?q=muller", { token: admin })).members;
    assert.equal(m.length, 1);
    assert.equal(m[0].gym, "Fitness Crissier");
  });

  await t.test("mot de passe oublié → reset → nouveau login", async () => {
    outbox.length = 0;
    ok(await call("POST", "/auth/forgot", { body: { email: "inconnu@x.ch" } }));
    assert.equal(outbox.length, 0);
    ok(await call("POST", "/auth/forgot", { body: { email: "gerant@fitness.ch" } }));
    const token = decodeURIComponent(/reset=([^"&\s]+)/.exec(outbox[0].text)[1]);
    assert.equal((await call("POST", "/auth/reset", { body: { token, password: "court" } })).statusCode, 400);
    ok(await call("POST", "/auth/reset", { body: { token, password: "nouveau-motdepasse" } }));
    assert.equal((await call("POST", "/auth/reset", { body: { token, password: "encore-un-autre" } })).statusCode, 400);
    ok(await call("POST", "/auth/login", { body: { email: "gerant@fitness.ch", password: "nouveau-motdepasse" } }));
  });

  await t.test("cron : protégé, tâches lancées une seule fois", async () => {
    assert.equal((await call("GET", "/cron/tick?job=nightly")).statusCode, 401);
    const h = { authorization: "Bearer cron-secret-test" };
    const n = ok(await call("GET", "/cron/tick?job=nightly", { headers: h }));
    assert.equal(n.done.nightly.passages_supprimes, 0);
    assert.equal(ok(await call("GET", "/cron/tick?job=nightly", { headers: h })).done.nightly, "déjà fait");
    outbox.length = 0;
    ok(await call("GET", "/cron/tick?job=monthly", { headers: h }));
    assert.ok(outbox.some((e) => /Rapport/.test(e.subject) && e.attachments?.length));
    ok(await call("GET", "/cron/tick?job=admin_recap", { headers: h }));
    assert.ok(outbox.some((e) => /Récap/.test(e.subject)));
  });

  await t.test("gérant isolé : ne voit pas les membres d'une autre salle", async () => {
    const g2 = ok(await call("POST", "/admin/gyms", { token: admin, body: { name: "Autre salle", user: { email: "autre@salle.ch", password: "motdepasse-autre" } } }));
    const t2 = ok(await call("POST", "/auth/login", { body: { email: "autre@salle.ch", password: "motdepasse-autre" } })).token;
    assert.equal(ok(await call("GET", "/gym/members", { token: t2 })).members.length, 0);
    assert.equal((await call("PATCH", "/gym/members/" + memberId, { token: t2, body: { notes: "x" } })).statusCode, 404);
    assert.equal((await call("DELETE", "/gym/members/" + memberId, { token: t2 })).statusCode, 404);
    assert.ok(g2.gym.id);
  });
});
