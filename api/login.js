const cors          = require("../lib/cors");
const sql           = require("../lib/db");
const { signToken } = require("../lib/auth");
const bcrypt        = require("bcryptjs");
const crypto        = require("crypto");
const { Resend }    = require("resend");
const { rateLimit, getIp } = require("../lib/ratelimit");

const FRONTEND = "https://volt-energy.ch";

async function ensureResetTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS password_resets (
      token        VARCHAR(80) PRIMARY KEY,
      email        VARCHAR(255) NOT NULL,
      account_type VARCHAR(10)  NOT NULL,
      expires_at   TIMESTAMP    NOT NULL,
      created_at   TIMESTAMP    DEFAULT NOW()
    )`;
}

const resetEmailHtml = (link) => `<style>@import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@800;900&display=swap');</style><div style="background:#040c22;padding:32px 16px;font-family:Arial,sans-serif"><div style="max-width:460px;margin:0 auto"><div style="background:#071433;border-radius:18px;overflow:hidden"><div style="background:#071433;padding:32px 32px 22px;border-bottom:1px solid rgba(0,87,255,.14)"><div style="font-size:76px;font-weight:900;color:#FFFFFF;letter-spacing:-2px;line-height:.9;font-family:'Barlow Condensed','Arial Black',Arial,sans-serif">VOLT.</div><div style="width:44px;height:4px;background:#0057FF;margin-top:14px;border-radius:2px"></div></div><div style="padding:28px 32px 22px"><div style="font-size:20px;font-weight:800;color:#FFFFFF;margin-bottom:10px">Réinitialise ton mot de passe 🔑</div><div style="font-size:14px;color:rgba(255,255,255,.55);line-height:1.8;margin-bottom:24px">Tu as demandé à réinitialiser ton mot de passe.<br/>Clique sur le bouton ci-dessous. Ce lien expire dans <strong style="color:#FFFFFF">1 heure</strong>.<br/><br/>Si tu n'es pas à l'origine de cette demande, ignore cet email.</div><a href="${link}" style="display:block;background:#0057FF;color:#FFFFFF;text-align:center;padding:15px 20px;border-radius:12px;font-size:15px;font-weight:900;text-decoration:none;letter-spacing:.04em;font-family:Arial Black,Arial,sans-serif">CHOISIR UN NOUVEAU MOT DE PASSE →</a></div><div style="padding:14px 32px;border-top:1px solid rgba(255,255,255,.05)"><div style="font-size:11px;color:rgba(255,255,255,.18)">VOLT. · Crissier · Switzerland</div></div></div></div></div>`;

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { action } = req.query;

  // ── MOT DE PASSE OUBLIÉ : envoi du lien de réinitialisation ──
  if (action === "forgot") {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email requis." });
    const lc = String(email).toLowerCase().trim();
    try {
      // Chercher d'abord côté membre (users), puis côté gérant (gyms)
      const [u] = await sql`SELECT id FROM users WHERE email = ${lc}`;
      let accountType = u ? "user" : null;
      if (!accountType) {
        const [g] = await sql`SELECT id FROM gyms WHERE email = ${lc}`;
        if (g) accountType = "gym";
      }
      // Réponse identique même si l'email n'existe pas (anti-énumération)
      if (!accountType) return res.json({ ok: true });

      await ensureResetTable();
      const token   = crypto.randomBytes(32).toString("hex");
      const expires = new Date(Date.now() + 3600 * 1000); // 1h
      // Invalider les anciens tokens de cet email puis insérer le nouveau
      await sql`DELETE FROM password_resets WHERE email = ${lc}`;
      await sql`INSERT INTO password_resets (token, email, account_type, expires_at)
                VALUES (${token}, ${lc}, ${accountType}, ${expires})`;

      const link = `${FRONTEND}/reset.html?token=${token}`;
      try {
        const resend = new Resend(process.env.RESEND_API_KEY);
        await resend.emails.send({
          from: "VOLT. <noreply@volt-energy.ch>",
          to: lc,
          subject: "🔑 Réinitialise ton mot de passe VOLT.",
          html: resetEmailHtml(link),
        });
      } catch (emailErr) { console.error("forgot email:", emailErr); }
      return res.json({ ok: true });
    } catch (e) {
      console.error("[login] forgot:", e);
      return res.status(500).json({ error: "Erreur serveur." });
    }
  }

  // ── RÉINITIALISATION : application du nouveau mot de passe ──
  if (action === "reset") {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: "Token et mot de passe requis." });
    if (String(password).length < 8) return res.status(400).json({ error: "Mot de passe trop court (min. 8 caractères)." });
    try {
      await ensureResetTable();
      const [row] = await sql`SELECT * FROM password_resets WHERE token = ${token} AND expires_at > NOW()`;
      if (!row) return res.status(400).json({ error: "Lien invalide ou expiré. Refais une demande." });
      const hash = await bcrypt.hash(password, 10);
      if (row.account_type === "gym") {
        await sql`UPDATE gyms SET password = ${hash} WHERE email = ${row.email}`;
      } else {
        await sql`UPDATE users SET password = ${hash} WHERE email = ${row.email}`;
      }
      await sql`DELETE FROM password_resets WHERE token = ${token}`;
      return res.json({ ok: true, account_type: row.account_type });
    } catch (e) {
      console.error("[login] reset:", e);
      return res.status(500).json({ error: "Erreur serveur." });
    }
  }

  // Rate limiting : 10 tentatives par IP sur 15 minutes
  const rl = rateLimit(`login:${getIp(req)}`, 10, 15 * 60 * 1000);
  if (!rl.ok) return res.status(429).json({ error: "Trop de tentatives. Réessaie dans 15 minutes." });

  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ error: "Email et mot de passe requis." });

  try {
    const [u] = await sql`
      SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.password,
             u.plan, u.subscribed, u.authorized, u.email_verified,
             u.gym_id, u.referral_code, u.free_months, u.sub_expires_at,
             g.name AS gym_name,
             (SELECT COUNT(*) FROM users WHERE referred_by = u.id AND subscribed = true) AS ref_count
      FROM users u LEFT JOIN gyms g ON u.gym_id = g.id
      WHERE u.email = ${email.toLowerCase()}
    `;

    if (!u) {
      // Cet email correspond-il à un compte gérant de fitness ? → rediriger vers l'espace gérant
      const [gym] = await sql`SELECT id FROM gyms WHERE email = ${email.toLowerCase()}`;
      if (gym)
        return res.status(403).json({
          error: "Ce compte est un espace Fitness (gérant). Connecte-toi sur la page Espace Fitness, pas sur l'app membre.",
          is_gym: true,
        });
      return res.status(401).json({ error: "Email ou mot de passe incorrect." });
    }

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
        initials: ((u.first_name||'?')[0] + (u.last_name||'?')[0]).toUpperCase(),
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
    console.error("[login]", e); return res.status(500).json({ error: "Erreur serveur." });
  }
};
