const cors          = require("../lib/cors");
const sql           = require("../lib/db");
const { signToken } = require("../lib/auth");
const bcrypt        = require("bcryptjs");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: "Email et mot de passe requis." });

  try {
    const [u] = await sql`
      SELECT u.*, g.name AS gym_name,
        (SELECT COUNT(*) FROM users WHERE referred_by = u.id AND subscribed = true) AS ref_count
      FROM users u LEFT JOIN gyms g ON u.gym_id = g.id
      WHERE u.email = ${email.toLowerCase()}
    `;

    if (!u) return res.status(401).json({ error: "Email ou mot de passe incorrect." });

    const ok = await bcrypt.compare(password, u.password);
    if (!ok) return res.status(401).json({ error: "Email ou mot de passe incorrect." });

    if (!u.email_verified) {
      return res.status(403).json({
        error: "Confirme ton adresse email avant de te connecter.",
        email_verified: false,
        email: u.email,
      });
    }

    // Vérification paresseuse : si sub_expires_at est passé, désabonner l'utilisateur
    if (u.subscribed && u.sub_expires_at && new Date(u.sub_expires_at) < new Date()) {
      u.subscribed = false;
      sql`UPDATE users SET subscribed = false WHERE id = ${u.id}`.catch(() => {});
    }

    const token = signToken({ id: u.id, email: u.email, role: "client" });
    return res.json({
      token,
      user: {
        id: u.id, name: `${u.first_name} ${u.last_name}`,
        email: u.email, phone: u.phone,
        initials: (u.first_name[0] + u.last_name[0]).toUpperCase(),
        plan: u.plan, subscribed: u.subscribed, authorized: u.authorized,
        gym: u.gym_name || null, gym_id: u.gym_id,
        referral_code: u.referral_code,
        referral_count: parseInt(u.ref_count) || 0,
        free_months: u.free_months,
        email_verified: true,
        sub_expires_at: u.sub_expires_at ? new Date(u.sub_expires_at).toISOString() : null,
      }
    });

  } catch (e) {
    return res.status(500).json({ error: "Erreur: " + e.message });
  }
};
