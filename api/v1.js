// Point d'entrée unique de l'API v1. vercel.json réécrit /api/v1/<chemin> → /api/v1?__path=<chemin>.
const { HttpError, cors, createRouter } = require("../lib/v1/http");

const router = createRouter();
for (const mod of ["auth", "gym", "admin", "tablet", "cron"]) require(`../lib/v1/routes/${mod}`)(router.route);

// Erreurs Postgres courantes → messages lisibles.
function pgError(e) {
  if (e.code === "23505") return new HttpError(409, "Cet élément existe déjà.");
  if (e.code === "23503") return new HttpError(400, "Élément lié introuvable.");
  if (e.code === "23514" || e.code === "22P02" || e.code === "22007" || e.code === "22008") return new HttpError(400, "Valeur invalide.");
  return null;
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  res.setHeader("Cache-Control", "no-store");

  const query = { ...(req.query || {}) };
  const raw = query.__path ?? String(req.url || "").split("?")[0].replace(/^\/api\/v1/, "");
  delete query.__path;
  const path = "/" + String(Array.isArray(raw) ? raw.join("/") : raw).replace(/^\/+|\/+$/g, "");

  const { handler: fn, params, notAllowed } = router.match(req.method, path);
  if (!fn) return res.status(notAllowed ? 405 : 404).json({ error: notAllowed ? "Méthode non autorisée." : "Route inconnue." });

  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const out = await fn({ req, res, body, query, params });
    if (!res.headersSent) res.status(200).json(out ?? { ok: true });
  } catch (e) {
    const err = e instanceof HttpError ? e : pgError(e);
    if (err) return res.status(err.status).json({ error: err.message });
    // Pas de données membre dans les logs : message et code technique uniquement.
    console.error(`[api/v1] ${req.method} ${path}: ${e.code || ""} ${e.message}`);
    res.status(500).json({ error: "Erreur serveur. Réessaie dans un instant." });
  }
};

module.exports.router = router;
