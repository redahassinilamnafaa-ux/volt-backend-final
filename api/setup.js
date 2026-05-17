const cors = require("../lib/cors");
const sql  = require("../lib/db");
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.query.secret !== "volt-setup-2025")
    return res.status(401).json({ error: "Non autorisé." });
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`;
    await sql`CREATE TABLE IF NOT EXISTS gyms (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      name TEXT NOT NULL, address TEXT, filiale TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL, phone TEXT, password TEXT NOT NULL,
      gym_id UUID REFERENCES gyms(id), plan TEXT DEFAULT 'none',
      subscribed BOOLEAN DEFAULT FALSE, authorized BOOLEAN DEFAULT TRUE,
      stripe_customer TEXT, referral_code TEXT UNIQUE,
      referred_by UUID REFERENCES users(id), free_months INT DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(), sub_expires_at TIMESTAMPTZ
    )`;
    await sql`CREATE TABLE IF NOT EXISTS scans (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES users(id) NOT NULL,
      gym_id UUID REFERENCES gyms(id), machine_id TEXT,
      scanned_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS payments (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id UUID REFERENCES users(id) NOT NULL,
      plan TEXT NOT NULL, amount_chf NUMERIC(10,2) NOT NULL,
      stripe_payment_id TEXT, method TEXT DEFAULT 'card',
      status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS cooldowns (
      user_id UUID PRIMARY KEY REFERENCES users(id),
      expires_at TIMESTAMPTZ NOT NULL
    )`;
    await sql`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_scans_user ON scans(user_id)`;
    return res.json({ ok: true, message: "Base de données VOLT initialisée !" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
