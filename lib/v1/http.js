// Outils HTTP de l'API v1 : erreurs, CORS, cookies, routeur.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const DEFAULT_ORIGINS = ["https://www.volt-energy.ch", "https://volt-energy.ch"];
// Prévisualisations Vercel du site et développement local.
const PREVIEW_RE = /^https:\/\/energy-volt-[a-z0-9-]+\.vercel\.app$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function allowedOrigin(origin) {
  if (!origin) return null;
  const list = (process.env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if ([...DEFAULT_ORIGINS, ...list].includes(origin) || PREVIEW_RE.test(origin)) return origin;
  return null;
}

function cors(req, res) {
  const origin = allowedOrigin(req.headers.origin);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, maxAgeS) {
  res.setHeader("Set-Cookie",
    `${name}=${encodeURIComponent(value)}; Path=/api/v1; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeS}`);
}

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.headers["x-real-ip"] || req.socket?.remoteAddress || null;
}

function sendCsv(res, filename, rows) {
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // BOM pour Excel ; séparateur « ; » (usage suisse).
  res.status(200).send("﻿" + rows.map((r) => r.map(esc).join(";")).join("\r\n"));
}

// Routeur minimal : route("GET", "/gym/members/:id", handler).
function createRouter() {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp("^" + pattern.replace(/\/:([a-z_]+)/g, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "$");
    routes.push({ method, re, keys, handler });
  };
  const match = (method, path) => {
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return { notAllowed: pathMatched };
  };
  return { route, match };
}

module.exports = { HttpError, fail, cors, parseCookies, setCookie, clientIp, sendCsv, createRouter };
