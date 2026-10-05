// Routes /auth/* et /setup (installation initiale).
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { fail, setCookie, clientIp } = require("../http");
const { COOKIE, SESSION_S, signSession, sha256, randomToken } = require("../auth");
const { limit } = require("../ratelimit");
const mail = require("../mail");

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || "");
const passwordOk = (p) => typeof p === "string" && p.length >= 10;
const PENDING = "!";

module.exports = function register(route) {
  route("POST", "/auth/login", async ({ req, res, body }) => {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email || !body.password) fail(400, "Email et mot de passe requis.");
    await limit(`login:${clientIp(req)}:${email}`, 8, 900);
    const sql = db();
    const [u] = await sql`
      SELECT u.id, u.role, u.gym_id, u.password_hash, u.name, g.name AS gym_name
      FROM gym_users u LEFT JOIN gyms g ON g.id = u.gym_id WHERE u.email = ${email}`;
    const ok = u && (await bcrypt.compare(String(body.password), u.password_hash));
    if (!ok) fail(401, "Email ou mot de passe incorrect.");
    const token = signSession(u);
    setCookie(res, COOKIE, token, SESSION_S);
    return { token, role: u.role, name: u.name, gym: u.gym_id ? { id: u.gym_id, name: u.gym_name } : null };
  });

  route("POST", "/auth/logout", async ({ res }) => {
    setCookie(res, COOKIE, "", 0);
    return { ok: true };
  });

  // Toujours 200 : ne révèle pas si l'email existe.
  route("POST", "/auth/forgot", async ({ req, body }) => {
    const email = String(body.email || "").trim().toLowerCase();
    if (!emailOk(email)) return { ok: true };
    await limit(`forgot:${clientIp(req)}`, 5, 3600);
    const sql = db();
    const [u] = await sql`SELECT id, email, gym_id FROM gym_users WHERE email = ${email}`;
    if (u) {
      const token = randomToken();
      await sql`INSERT INTO password_resets (token_hash, user_id, expires_at)
                VALUES (${sha256(token)}, ${u.id}, now() + interval '1 hour')`;
      await mail.sendPasswordReset(u, token);
    }
    return { ok: true };
  });

  route("POST", "/auth/reset", async ({ req, body }) => {
    await limit(`reset:${clientIp(req)}`, 10, 3600);
    if (!passwordOk(body.password)) fail(400, "Le mot de passe doit contenir au moins 10 caractères.");
    const sql = db();
    const [r] = await sql`
      SELECT token_hash, user_id FROM password_resets
      WHERE token_hash = ${sha256(String(body.token || ""))} AND used_at IS NULL AND expires_at > now()`;
    if (!r) fail(400, "Lien invalide ou expiré. Refais une demande.");
    const hash = await bcrypt.hash(body.password, 12);
    await sql.transaction([
      sql`UPDATE gym_users SET password_hash = ${hash} WHERE id = ${r.user_id}`,
      sql`UPDATE password_resets SET used_at = now() WHERE user_id = ${r.user_id} AND used_at IS NULL`,
    ]);
    return { ok: true };
  });

  // Installation (idempotente, sans secret) : crée la base volt_v1, applique les migrations,
  // puis, tant qu'aucun admin n'a choisi son mot de passe, envoie un lien d'activation à ADMIN_EMAIL.
  // Seul le détenteur de cette boîte mail peut activer le compte.
  route("POST", "/setup", async ({ req }) => {
    const database = await db.ensureDatabase();
    const sql = db();
    const dir = path.join(process.cwd(), "migrations", "v1");
    const applied = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      const statements = fs.readFileSync(path.join(dir, file), "utf8")
        .split(/;\s*(?:\r?\n|$)/)
        .map((s) => s.split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n").trim())
        .filter(Boolean);
      for (const st of statements) await sql(st);
      applied.push(file);
    }
    // Compte admin : mot de passe « ! » = pas encore choisi (aucun mot de passe ne peut correspondre).
    const email = (process.env.ADMIN_EMAIL || mail.VOLT_EMAIL()).trim().toLowerCase();
    const admins = await sql`SELECT id, email, gym_id, password_hash FROM gym_users WHERE role = 'admin'`;
    let admin = "actif";
    if (!admins.length || admins.every((a) => a.password_hash === PENDING)) {
      await limit(`setup:${clientIp(req)}`, 3, 3600, "Lien déjà envoyé. Vérifie la boîte mail de l'admin.");
      const [u] = admins.length ? admins : await sql`
        INSERT INTO gym_users (role, email, password_hash, name) VALUES ('admin', ${email}, ${PENDING}, 'VOLT.')
        RETURNING id, email, gym_id`;
      const token = randomToken();
      await sql`INSERT INTO password_resets (token_hash, user_id, expires_at)
                VALUES (${sha256(token)}, ${u.id}, now() + interval '24 hours')`;
      const r = await mail.sendAdminActivation(u, token);
      admin = r.ok ? `lien d'activation envoyé à ${u.email}` : `envoi de l'email échoué : ${r.error}`;
    }
    return { ok: true, database, migrations: applied, admin };
  });
};

module.exports.passwordOk = passwordOk;
module.exports.emailOk = emailOk;
