const cors          = require("../lib/cors");
const sql           = require("../lib/db");
const { signToken } = require("../lib/auth");
const bcrypt        = require("bcryptjs");
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();
  const { firstName, lastName, email, phone, password } = req.body || {};
  if (!firstName || !lastName || !email || !password)
    return res.status(400).json({ error: "Champs obligatoires manquants." });
  if (password.length < 8)
    return res.status(400).json({ error: "Mot de passe minimum 8 caractères." });
  try {
    const exists = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
    if (exists.length > 0)
      return res.status(400).json({ error: "Cet email est déjà utilisé." });
    const hash = await bcrypt.hash(password, 10);
    const code = "VOLT" + Math.random().toString(36).slice(2, 8).toUpperCase();
    const [u] = await sql`
      INSERT INTO users (first_name, last_name, email, phone, password, referral_code)
      VALUES (${firstName}, ${lastName}, ${email.toLowerCase()}, ${phone || null}, ${hash}, ${code})
      RETURNING id, first_name, last_name, email, phone, plan, subscribed, authorized, referral_code, free_months
    `;
    const token = signToken({ id: u.id, email: u.email, role: "client" });
    return res.status(201).json({
      token,
      user: {
        id: u.id, name: `${u.first_name} ${u.last_name}`,
        email: u.email, phone: u.phone,
        initials: (u.first_name[0] + u.last_name[0]).toUpperCase(),
        plan: u.plan, subscribed: u.subscribed, authorized: u.authorized,
        referral_code: u.referral_code, referral_count: 0, free_months: u.free_months,
      }
    });
  } catch (e) {
    return res.status(500).json({ error: "Erreur: " + e.message });
  }
};
