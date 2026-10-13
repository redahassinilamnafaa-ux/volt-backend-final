// Routes /track — compteur de fréquentation du site public, sans cookie et sans conserver l'adresse IP.
const db = require("../db");
const { sha256 } = require("../auth");
const { limit } = require("../ratelimit");

const BOT = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|uptime|monitor|preview|facebookexternalhit|curl|wget|python|axios|node-fetch/i;
const PRIVATE = /^\/(admin|fitness|api|voltapp|reset)(\/|$)/i;
const OWN = /(^|\.)volt-energy\.ch$/i;
const KINDS = ["contact", "quiz", "tel", "mail", "whatsapp", "sortie", "lecture"];
const clip = (v, n) => (v == null || v === "" ? null : String(v).trim().slice(0, n) || null);
const int = (v, max) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(max, Math.round(Number(v)))));

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase().slice(0, 100) || null;
  } catch (e) {
    return null;
  }
}

function device(ua) {
  if (/iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(ua)) return "tablet";
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)) return "mobile";
  return "desktop";
}

function header(req, name) {
  const v = req.headers[name];
  if (!v) return null;
  try {
    return decodeURIComponent(String(v)).slice(0, 80) || null;
  } catch (e) {
    return String(v).slice(0, 80) || null;
  }
}

module.exports = function register(route) {
  // Envoyé par navigator.sendBeacon (corps text/plain, pas de pré-vol CORS) : la réponse n'est jamais lue.
  // Page vue : {p, r, s, l, n}. Action : {e, x, p, r, s, d, t} (e = type, x = libellé, d = % lu, t = secondes).
  route("POST", "/track", async ({ req }) => {
    const ua = String(req.headers["user-agent"] || "");
    if (!ua || BOT.test(ua)) return { ok: true };
    let b = req.body;
    if (typeof b === "string") {
      try { b = JSON.parse(b); } catch (e) { b = null; }
    }
    if (!b || typeof b !== "object") return { ok: true };
    const path = String(b.p || "/").split("?")[0].split("#")[0].slice(0, 200);
    if (!path.startsWith("/") || PRIVATE.test(path)) return { ok: true };

    const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    await limit("track:" + sha256(ip || "?").slice(0, 16), 600, 3600, "Trop de pages vues.");

    const ref = host(b.r);
    const referrer = ref && !OWN.test(ref) ? ref : null;
    const source = b.s ? String(b.s).trim().toLowerCase().slice(0, 60) || null : null;
    if (b.e != null) {
      if (!KINDS.includes(b.e)) return { ok: true };
      let from = null;
      if (ref && OWN.test(ref)) {
        try { from = new URL(b.r).pathname.slice(0, 200); } catch (e) {}
      }
      await db()`
        INSERT INTO site_events (kind, label, path, from_path, source, depth, seconds)
        VALUES (${b.e}, ${clip(b.x, 80)}, ${path}, ${from}, ${source || referrer || (from ? null : "direct")}, ${int(b.d, 100)}, ${int(b.t, 3600)})`;
      return { ok: true };
    }
    const lang = b.l ? String(b.l).slice(0, 2).toLowerCase() : null;
    await db()`
      INSERT INTO site_views (path, referrer, source, country, region, city, device, lang, new_visit)
      VALUES (${path}, ${referrer}, ${source}, ${header(req, "x-vercel-ip-country")}, ${header(req, "x-vercel-ip-country-region")},
              ${header(req, "x-vercel-ip-city")}, ${device(ua)}, ${lang}, ${!!b.n})`;
    return { ok: true };
  });
};
