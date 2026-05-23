const cors          = require("../lib/cors");
const sql           = require("../lib/db");
const { signToken } = require("../lib/auth");
const bcrypt        = require("bcryptjs");
const { Resend }    = require("resend");
const crypto        = require("crypto");

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── POST /api/register?action=resend → Renvoyer email confirmation ──
  if (req.method === "POST" && req.query.action === "resend") {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Email manquant." });
    try {
      const users = await sql`SELECT id, first_name, email_verified FROM users WHERE email = ${email.toLowerCase()}`;
      if (!users.length) return res.status(400).json({ error: "Utilisateur introuvable." });
      const user = users[0];
      if (user.email_verified) return res.status(400).json({ error: "Email déjà vérifié." });
      await sql`DELETE FROM verify_tokens WHERE user_id = ${user.id}`;
      const verifyToken = crypto.randomBytes(32).toString("hex");
      const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await sql`INSERT INTO verify_tokens (user_id, token, expires_at) VALUES (${user.id}, ${verifyToken}, ${expiry})`;
      const lien = `https://volt-backend-final.vercel.app/api/verify-email?token=${verifyToken}`;
      await resend.emails.send({
        from: "VOLT. <noreply@volt-energy.ch>",
        to: email,
        subject: "⚡ Confirme ton compte VOLT.",
        html: `<div style="background:#0A0F1E;padding:40px 20px;font-family:Arial,sans-serif"><div style="max-width:480px;margin:0 auto;background:#111827;border-radius:20px;overflow:hidden"><div style="background:linear-gradient(135deg,#003FCC,#0057FF);padding:32px 36px"><div style="font-size:48px;font-weight:900;color:#fff;letter-spacing:-2px">VOLT.</div></div><div style="padding:32px 36px"><div style="font-size:22px;font-weight:800;color:#fff;margin-bottom:12px">Confirme ton email ⚡</div><div style="font-size:15px;color:rgba(255,255,255,0.6);line-height:1.7;margin-bottom:28px">Salut <strong style="color:#fff">${user.first_name}</strong>,<br/>Voici ton nouveau lien de confirmation.</div><a href="${lien}" style="display:block;background:#0057FF;color:#fff;text-align:center;padding:15px 24px;border-radius:50px;font-size:17px;font-weight:900;text-decoration:none">CONFIRMER MON EMAIL →</a><div style="margin-top:20px;font-size:12px;color:rgba(255,255,255,0.25)">Ce lien expire dans 24h.</div></div></div></div>`
      });
      return res.json({ ok: true });
    } catch(e) { return res.status(500).json({ error: "Erreur: " + e.message }); }
  }

  if (req.method !== "POST") return res.status(405).end();

  const { firstName, lastName, email, phone, password } = req.body || {};
  if (!firstName || !lastName || !email || !password)
    return res.status(400).json({ error: "Champs obligatoires manquants." });
  if (password.length < 8)
    return res.status(400).json({ error: "Mot de passe minimum 8 caractères." });

  // ── Validation format email ─────────────────────────────────────
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email))
    return res.status(400).json({ error: "Adresse email invalide." });

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

    // ── Génère le token de vérification email ──────────────────────
    const verifyToken = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await sql`
      INSERT INTO verify_tokens (user_id, token, expires_at)
      VALUES (${u.id}, ${verifyToken}, ${expiry})
    `;

    // ── Envoie l'email de confirmation ─────────────────────────────
    const lien = `https://volt-backend-final.vercel.app/api/verify-email?token=${verifyToken}`;
    try {
      await resend.emails.send({
        from: "VOLT. <noreply@volt-energy.ch>",
        to: u.email,
        subject: "⚡ Confirme ton compte VOLT.",
        html: `
          <div style="background:#0A0F1E;padding:40px 20px;font-family:Arial,sans-serif">
            <div style="max-width:480px;margin:0 auto;background:#111827;border-radius:20px;overflow:hidden">
              <div style="background:linear-gradient(135deg,#003FCC,#0057FF);padding:32px 36px">
                <div style="font-size:48px;font-weight:900;color:#fff;letter-spacing:-2px">VOLT.</div>
                <div style="font-size:13px;color:rgba(255,255,255,0.5);margin-top:6px;text-transform:uppercase;letter-spacing:.06em">Système d'accès QR</div>
              </div>
              <div style="padding:32px 36px">
                <div style="font-size:22px;font-weight:800;color:#fff;margin-bottom:12px">Confirme ton email ⚡</div>
                <div style="font-size:15px;color:rgba(255,255,255,0.6);line-height:1.7;margin-bottom:28px">
                  Salut <strong style="color:#fff">${u.first_name}</strong>,<br/>
                  Clique sur le bouton ci-dessous pour activer ton compte VOLT.
                </div>
                <a href="${lien}" style="display:block;background:#0057FF;color:#fff;text-align:center;padding:15px 24px;border-radius:50px;font-size:17px;font-weight:900;text-decoration:none">
                  CONFIRMER MON EMAIL →
                </a>
                <div style="margin-top:20px;font-size:12px;color:rgba(255,255,255,0.25)">
                  Ce lien expire dans 24h. Si tu n'as pas créé de compte, ignore cet email.
                </div>
              </div>
              <div style="padding:16px 36px 28px;border-top:1px solid rgba(255,255,255,0.05)">
                <div style="font-size:12px;color:rgba(255,255,255,0.2)">VOLT. Energy · Genève · info@volt.energy.ch</div>
              </div>
            </div>
          </div>
        `
      });
    } catch (emailErr) {
      console.error("Email confirmation error:", emailErr);
    }

    // ── Retourne le token JWT et les infos utilisateur ──────────────
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
    return res.status(500).json({ error: "Erreur: " + e.message });
  }
};
