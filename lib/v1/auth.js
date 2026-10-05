// Authentification v1 : sessions JWT (cookie httpOnly ou Bearer) et jetons de tablette.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const db = require("./db");
const { fail, parseCookies } = require("./http");

const COOKIE = "volt_session";
const SESSION_S = 7 * 24 * 3600;

function secret() {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET non configuré.");
  return process.env.JWT_SECRET;
}

function signSession(user) {
  return jwt.sign({ uid: user.id, role: user.role, gym_id: user.gym_id || null }, secret(), { expiresIn: SESSION_S });
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const randomToken = (prefix = "") => prefix + crypto.randomBytes(32).toString("base64url");

function bearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

// Session admin / gym. Le gym_id vient toujours du jeton, jamais du client.
function requireUser(req, role) {
  const token = bearer(req) || parseCookies(req)[COOKIE];
  if (!token) fail(401, "Non connecté.");
  let s;
  try { s = jwt.verify(token, secret()); } catch { fail(401, "Session expirée. Reconnecte-toi."); }
  if (!s || !s.uid || (role && s.role !== role)) fail(403, "Accès refusé.");
  if (s.role === "gym" && !s.gym_id) fail(403, "Accès refusé.");
  return s;
}

// Tablette : jeton d'appareil long, stocké haché dans stations.tablet_token_hash.
async function requireTablet(req) {
  const token = bearer(req);
  if (!token || !token.startsWith("vt_")) fail(401, "Jeton d'appareil manquant.");
  const sql = db();
  const [station] = await sql`
    SELECT s.id, s.gym_id, s.name, s.relay_host, g.name AS gym_name
    FROM stations s JOIN gyms g ON g.id = s.gym_id
    WHERE s.tablet_token_hash = ${sha256(token)}`;
  if (!station) fail(401, "Jeton d'appareil invalide.");
  return station;
}

module.exports = { COOKIE, SESSION_S, signSession, sha256, randomToken, requireUser, requireTablet };
