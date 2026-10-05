// Limitation de débit persistante (table rate_hits) : fiable entre instances serverless.
const db = require("./db");
const { fail } = require("./http");

async function limit(key, max, windowS, message = "Trop de tentatives. Réessaie dans quelques minutes.") {
  const sql = db();
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM rate_hits WHERE key = ${key} AND at > now() - make_interval(secs => ${windowS})`;
  if (n >= max) fail(429, message);
  await sql`INSERT INTO rate_hits (key) VALUES (${key})`;
}

module.exports = { limit };
