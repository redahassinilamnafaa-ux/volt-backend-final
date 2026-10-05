// Base v1 (Neon « volt_v1 »), séparée de l'ancienne base de l'app membre.
const { neon } = require("@neondatabase/serverless");

let sql = null;
module.exports = function db() {
  if (!sql) {
    if (!process.env.DATABASE_URL_V1) throw new Error("DATABASE_URL_V1 non configuré.");
    sql = neon(process.env.DATABASE_URL_V1);
  }
  return sql;
};

// Tests : injecter un client compatible (PGlite).
module.exports.__set = (fn) => { sql = fn; };
