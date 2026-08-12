const cors          = require("../lib/cors");
const sql           = require("../lib/db");
const { signToken } = require("../lib/auth");
const bcrypt        = require("bcryptjs");
const crypto        = require("crypto");
const { rateLimit, getIp } = require("../lib/ratelimit");

const { sendVerifyEmail } = require("../lib/email");

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "POST" && req.query.action === "resend") {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email manquant." });
    try {
      const users = await sql`SELECT id, first_name, email_verified FROM users WHERE email = ${email.toLowerCase()}`;
      if (!users.length) return res.status(400).json({ error: "Utilisateur introuvable." });
      const user = users[0];
      if (user.email_verified) return res.status(400).json({ error: "Email déjà vérifié." });
      await sql`DELETE FROM verify_tokens WHERE user_id = ${String(user.id)}`;
      const verifyToken = crypto.randomBytes(32).toString("hex");
      const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await sql`INSERT INTO verify_tokens (user_id, token, expires_at) VALUES (${String(user.id)}, ${verifyToken}, ${expiry})`;
      const lien = `https://volt-backend-final.vercel.app/api/verify-email?token=${verifyToken}`;
      await sendVerifyEmail(email, user.first_name || "", lien, { resent: true });
      return res.json({ ok: true });
    } catch(e) { console.error("[register]", e); return res.status(500).json({ error: "Erreur serveur." }); }
  }

  if (req.method !== "POST") return res.status(405).end();

  // Rate limiting : 5 inscriptions par IP par heure
  const rl = rateLimit(`register:${getIp(req)}`, 5, 60 * 60 * 1000);
  if (!rl.ok) return res.status(429).json({ error: "Trop de tentatives. Réessaie dans une heure." });

  const { firstName, lastName, email, phone, password, ref_code } = req.body || {};
  if (!firstName || !lastName || !email || !password)
    return res.status(400).json({ error: "Champs obligatoires manquants." });
  if (password.length < 8)
    return res.status(400).json({ error: "Mot de passe minimum 8 caractères." });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email))
    return res.status(400).json({ error: "Adresse email invalide." });

  try {
    const exists = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
    if (exists.length > 0)
      return res.status(400).json({ error: "Cet email est déjà utilisé." });

    const hash = await bcrypt.hash(password, 10);
    const code = "VOLT" + Math.random().toString(36).slice(2, 8).toUpperCase();

    let referredById = null;
    if (ref_code) {
      // Le parrain doit avoir un email vérifié (empêche comptes jetables intermédiaires)
      const [referrer] = await sql`SELECT id FROM users WHERE referral_code = ${ref_code.toUpperCase()} AND email_verified = true`;
      if (referrer) referredById = referrer.id;
    }

    const [u] = await sql`
      INSERT INTO users (first_name, last_name, email, phone, password, referral_code, referred_by)
      VALUES (${firstName}, ${lastName}, ${email.toLowerCase()}, ${phone || null}, ${hash}, ${code}, ${referredById})
      RETURNING id, first_name, last_name, email, phone, plan, subscribed, authorized, referral_code, free_months
    `;

    const verifyToken = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await sql`INSERT INTO verify_tokens (user_id, token, expires_at) VALUES (${String(u.id)}, ${verifyToken}, ${expiry})`;

    const lien = `https://volt-backend-final.vercel.app/api/verify-email?token=${verifyToken}`;
    try {
      await sendVerifyEmail(u.email, u.first_name || "", lien);
    } catch (emailErr) {
      console.error("Email confirmation error:", emailErr);
    }

    const token = signToken({ id: u.id, email: u.email, role: "client" });
    return res.status(201).json({
      token,
      user: {
        id: u.id, name: `${u.first_name} ${u.last_name}`,
        email: u.email, phone: u.phone,
        initials: (u.first_name[0] + u.last_name[0]).toUpperCase(),
        plan: u.plan, subscribed: u.subscribed, authorized: u.authorized,
        referral_code: u.referral_code, referral_count: 0, free_months: u.free_months,
        email_verified: false,
      }
    });

  } catch (e) {
    console.error("[register]", e); return res.status(500).json({ error: "Erreur serveur." });
  }
};
