const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  try {
    const [u] = await sql`
      SELECT u.*, g.name AS gym_name,
        (SELECT COUNT(*) FROM users WHERE referred_by = u.id AND subscribed = true) AS ref_count
      FROM users u LEFT JOIN gyms g ON u.gym_id = g.id
      WHERE u.id = ${auth.id}
    `;

    if (!u) return res.status(404).json({ error: "Utilisateur introuvable." });

    // Vérification paresseuse : si sub_expires_at est passé, désabonner
    if (u.subscribed && u.sub_expires_at && new Date(u.sub_expires_at) < new Date()) {
      u.subscribed = false;
      sql`UPDATE users SET subscribed = false WHERE id = ${u.id}`.catch(() => {});
    }

    return res.json({
      user: {
        id: u.id, name: `${u.first_name} ${u.last_name}`,
        email: u.email, phone: u.phone,
        initials: (u.first_name[0] + u.last_name[0]).toUpperCase(),
        plan: u.plan, subscribed: u.subscribed, authorized: u.authorized,
        gym: u.gym_name || null, gym_id: u.gym_id,
        referral_code: u.referral_code,
        referral_count: parseInt(u.ref_count) || 0,
        free_months: u.free_months,
        email_verified: u.email_verified,
        sub_expires_at: u.sub_expires_at ? new Date(u.sub_expires_at).toISOString() : null,
      }
    });

  } catch (e) {
    return res.status(500).json({ error: "Erreur: " + e.message });
  }
};
