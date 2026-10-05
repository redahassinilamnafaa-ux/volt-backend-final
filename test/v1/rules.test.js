const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../../lib/v1/rules");
const M = require("../../lib/v1/members");

test("computeEnd : début + N mois − 1 jour, fins de mois gérées", () => {
  assert.equal(R.computeEnd("2026-10-05", 1), "2026-11-04");
  assert.equal(R.computeEnd("2026-10-05", 12), "2027-10-04");
  assert.equal(R.computeEnd("2027-01-31", 1), "2027-02-28");
  assert.equal(R.computeEnd("2028-01-31", 1), "2028-02-29");
  assert.equal(R.computeEnd("2026-01-01", 1), "2026-01-31");
  assert.equal(R.computeEnd("2026-12-15", 1), "2027-01-14");
  assert.equal(R.computeEnd("2026-03-31", 1), "2026-04-30");
  assert.equal(R.computeEnd("2026-01-28", 1), "2026-02-27");
});

test("parseDuree et normalizeCode", () => {
  assert.equal(R.parseDuree("1m"), 1);
  assert.equal(R.parseDuree("36m"), 36);
  assert.equal(R.parseDuree("37m"), null);
  assert.equal(R.parseDuree("0m"), null);
  assert.equal(R.normalizeCode(" 1002-4583 0000 0001 "), "1002458300000001");
  assert.equal(R.normalizeCode("ab12cd"), "AB12CD");
  assert.equal(R.normalizeCode("12345"), null);
  assert.equal(R.normalizeCode("12#456"), null);
});

test("memberStatus : ordre bloqué > pause > à venir > expiré > actif", () => {
  const base = { statut: "actif", debut: "2026-01-01", fin: "2026-12-31", reprise: null };
  const t = "2026-10-05";
  assert.equal(R.memberStatus(base, t), "actif");
  assert.equal(R.memberStatus({ ...base, fin: "2026-10-05" }, t), "actif"); // fin incluse
  assert.equal(R.memberStatus({ ...base, fin: "2026-10-04" }, t), "expire");
  assert.equal(R.memberStatus({ ...base, debut: "2026-10-06" }, t), "avenir");
  assert.equal(R.memberStatus({ ...base, statut: "pause" }, t), "pause");
  assert.equal(R.memberStatus({ ...base, statut: "pause", reprise: "2026-10-06" }, t), "pause");
  assert.equal(R.memberStatus({ ...base, statut: "pause", reprise: "2026-10-05" }, t), "actif");
  assert.equal(R.memberStatus({ ...base, statut: "bloque", fin: "2020-01-01" }, t), "bloque");
});

test("authorize : inconnu, inactif, délai de 15 min, ok", () => {
  const now = new Date("2026-10-05T10:00:00Z");
  const member = { statut: "actif", debut: "2026-01-01", fin: "2026-12-31" };
  assert.deepEqual(R.authorize({ member: null, now }), { result: "unknown", log: "inconnu" });
  assert.deepEqual(R.authorize({ member: { ...member, statut: "bloque" }, now }), { result: "inactive", reason: "bloque", log: "bloque" });
  assert.deepEqual(R.authorize({ member, lastOkAt: new Date(now - 60e3), now }), { result: "wait", wait_s: 840, log: "delai" });
  assert.deepEqual(R.authorize({ member, lastOkAt: new Date(now - 900e3), now }), { result: "ok", log: "ok" });
  assert.deepEqual(R.authorize({ member, lastOkAt: null, now }), { result: "ok", log: "ok" });
});

test("todayZurich suit le fuseau suisse", () => {
  assert.equal(R.todayZurich(new Date("2026-10-04T22:30:00Z")), "2026-10-05"); // 00:30 CEST
  assert.equal(R.todayZurich(new Date("2026-12-31T23:30:00Z")), "2027-01-01"); // 00:30 CET
  assert.equal(R.hourZurich(new Date("2026-07-01T01:00:00Z")), 3);
  assert.equal(R.hourZurich(new Date("2026-01-01T02:00:00Z")), 3);
});

test("toLogResult et livraisons", () => {
  assert.equal(R.toLogResult("wait"), "delai");
  assert.equal(R.toLogResult("unknown"), "inconnu");
  assert.equal(R.toLogResult("inactive", "pause"), "pause");
  assert.equal(R.toLogResult("ok"), "ok");
  assert.equal(R.toLogResult("bizarre"), null);
  assert.deepEqual(R.deliveryStatus("2026-10-01", 30, "2026-10-05"), { next: "2026-10-31", left: 26, status: "planifiee" });
  assert.equal(R.deliveryStatus("2026-10-01", 10, "2026-10-05").status, "a_livrer");
  assert.equal(R.nextMaintenance({ installed_on: "2026-04-10" }), "2026-10-10");
  assert.equal(R.nextMaintenance({ planned_on: "2026-11-02", installed_on: "2026-04-10" }), "2026-11-02");
});

test("validateNew : champs obligatoires et calcul de la fin", () => {
  const ok = { prenom: "Léa", nom: "Muller", telephone: "+41 79 123 45 67", email: "Lea@Mail.ch", numero_acces: "1002 4583 0000 0001", debut: "05.10.2026", duree: "1m" };
  const { value } = M.validateNew(ok);
  assert.equal(value.email, "lea@mail.ch");
  assert.equal(value.code_acces, "1002458300000001");
  assert.equal(value.debut, "2026-10-05");
  assert.equal(value.fin, "2026-11-04");
  assert.match(M.validateNew({ ...ok, telephone: "" }).error, /Téléphone/);
  assert.match(M.validateNew({ ...ok, email: "x" }).error, /Email/);
  assert.match(M.validateNew({ ...ok, duree: null }).error, /Durée ou date de fin/);
  assert.equal(M.validateNew({ ...ok, duree: null, fin: "2027-03-31" }).value.fin, "2027-03-31");
  assert.match(M.validateNew({ ...ok, duree: null, fin: "2026-01-01" }).error, /précède/);
});

test("applyPatch : pause avec prolongation et reprise manuelle", () => {
  const cur = { prenom: "Léa", nom: "Muller", telephone: "+41791234567", email: "lea@mail.ch", code_acces: "1002458300000001",
    naissance: null, ref_salle: null, notes: null, debut: "2026-10-01", fin: "2026-10-31", duree: "1m",
    statut: "actif", reprise: null, prolonger: false, motif: null, pause_debut: null, pause_ext_applied: false };
  const today = "2026-10-05";
  // Pause jusqu'au 15.10 avec prolongation : +10 jours.
  const p = M.applyPatch(cur, { statut: "pause", reprise: "2026-10-15", prolonger: true }, today).value;
  assert.equal(p.fin, "2026-11-10");
  assert.equal(p.pause_ext_applied, true);
  // Pause sans date de reprise, puis reprise manuelle 7 jours plus tard : +7 jours.
  const p2 = M.applyPatch(cur, { statut: "pause", prolonger: true }, today).value;
  assert.equal(p2.fin, "2026-10-31");
  const back = M.applyPatch({ ...cur, ...p2 }, { statut: "actif" }, "2026-10-12").value;
  assert.equal(back.fin, "2026-11-07");
  assert.equal(back.statut, "actif");
  assert.equal(back.pause_debut, null);
  // Blocage : motif obligatoire.
  assert.match(M.applyPatch(cur, { statut: "bloque" }, today).error, /Motif/);
  // Changement de durée : fin recalculée ; date de fin libre : durée effacée.
  assert.equal(M.applyPatch(cur, { duree: "12m" }, today).value.fin, "2027-09-30");
  const free = M.applyPatch(cur, { fin: "2027-01-15" }, today).value;
  assert.equal(free.fin, "2027-01-15");
  assert.equal(free.duree, null);
  // Champ simple : dates inchangées.
  assert.equal(M.applyPatch(cur, { notes: "VIP" }, today).value.fin, "2026-10-31");
});

test("migrations : découpage SQL et contrat v2.0 haché comme la page", async () => {
  const fs = require("fs"), crypto = require("crypto");
  const { splitSql } = require("../../lib/v1/routes/auth");
  assert.deepEqual(splitSql("-- c\nselect 1;\nselect $x$a;\nb$x$;\n"), ["select 1", "select $x$a;\nb$x$"]);
  const st = splitSql(fs.readFileSync(__dirname + "/../../migrations/v1/002_contract_v2.sql", "utf8"));
  assert.equal(st.length, 2);
  const txt = /\$ct\$([\s\S]*?)\$ct\$/.exec(st[1])[1];
  assert.match(txt, /^1\. Parties\n/);
  assert.match(txt, /\nv2\.0$/);
  assert.equal(crypto.createHash("sha256").update(txt).digest("hex"), "073aecea1735d705cce1c3ca8c6ccda8208c325dd505fa369898e1ed9dddbbd8");
});
