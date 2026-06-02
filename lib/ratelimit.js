/**
 * Rate limiter en mémoire — sans dépendance externe.
 * Compatible Vercel serverless (best-effort : la mémoire est locale à l'instance).
 * Pour un rate limiting strict en multi-instance, utiliser Upstash Redis.
 */

const store = new Map(); // key → { count, resetAt }

/**
 * @param {string} key      - Identifiant unique (IP + endpoint)
 * @param {number} limit    - Nombre max de requêtes autorisées
 * @param {number} windowMs - Fenêtre de temps en millisecondes
 * @returns {{ ok: boolean, remaining: number, resetAt: number }}
 */
function rateLimit(key, limit, windowMs) {
  const now = Date.now();

  // Nettoyage périodique des entrées expirées (1 chance sur 100)
  if (Math.random() < 0.01) {
    for (const [k, v] of store.entries()) {
      if (v.resetAt < now) store.delete(k);
    }
  }

  const entry = store.get(key);

  if (!entry || entry.resetAt < now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, resetAt: now + windowMs };
  }

  entry.count++;
  store.set(key, entry);

  const remaining = Math.max(0, limit - entry.count);
  return { ok: entry.count <= limit, remaining, resetAt: entry.resetAt };
}

/**
 * Retourne l'IP de la requête (compatible Vercel / proxy).
 */
function getIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    'unknown'
  );
}

module.exports = { rateLimit, getIp };
