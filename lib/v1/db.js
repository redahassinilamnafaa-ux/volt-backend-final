// Base v1 « volt_v1 », séparée de l'ancienne base de l'app membre.
// Sans DATABASE_URL_V1, l'adresse est dérivée de DATABASE_URL (même serveur Neon, base volt_v1) :
// aucun identifiant supplémentaire à copier.
const { neon } = require("@neondatabase/serverless");

const DB_NAME = "volt_v1";
let sql = null;

function v1Url() {
  if (process.env.DATABASE_URL_V1) return process.env.DATABASE_URL_V1;
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL non configuré.");
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = "/" + DB_NAME;
  return u.toString();
}

function db() {
  if (!sql) sql = neon(v1Url());
  return sql;
}

// Crée la base volt_v1 sur le serveur de DATABASE_URL si elle n'existe pas (installation).
async function ensureDatabase() {
  if (process.env.DATABASE_URL_V1 || !process.env.DATABASE_URL) return "configurée";
  const base = neon(process.env.DATABASE_URL);
  const [exists] = await base`SELECT 1 FROM pg_database WHERE datname = ${DB_NAME}`;
  if (exists) return "existante";
  await base(`CREATE DATABASE ${DB_NAME}`);
  return "créée";
}

module.exports = db;
module.exports.ensureDatabase = ensureDatabase;
// Tests : injecter un client compatible (PGlite).
module.exports.__set = (fn) => { sql = fn; };
