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
      await sql`DELETE FROM verify_tokens WHERE user_id = ${String(user.id)}`;
      const verifyToken = crypto.randomBytes(32).toString("hex");
      const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await sql`INSERT INTO verify_tokens (user_id, token, expires_at) VALUES (${String(user.id)}, ${verifyToken}, ${expiry})`;
      const lien = `https://volt-backend-final.vercel.app/api/verify-email?token=${verifyToken}`;
      await resend.emails.send({
        from: "VOLT. <noreply@volt-energy.ch>",
        to: email,
        subject: "⚡ Confirme ton compte VOLT.",
        html: `<div style="background:#060D2E;padding:40px 20px;font-family:Arial,sans-serif"><div style="max-width:480px;margin:0 auto;border-radius:24px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5)"><div style="background:linear-gradient(135deg,#060D2E 0%,#0A1A5C 40%,#0D2280 70%,#1a3aaa 100%);padding:40px 36px 36px;position:relative;overflow:hidden"><div style="position:absolute;top:0;right:0;width:300px;height:300px;background:radial-gradient(ellipse at 80% 20%,rgba(0,87,255,.6),transparent 70%);pointer-events:none"></div><div style="position:relative;z-index:1"><div style="font-size:64px;font-weight:900;color:#ffffff;letter-spacing:-3px;line-height:1;font-family:Arial Black,Arial,sans-serif">VOLT.</div><div style="font-size:13px;color:rgba(255,255,255,0.45);margin-top:8px;font-weight:600;letter-spacing:.08em;text-transform:uppercase">Système d'accès à l'aide d'un QR code</div></div></div><div style="background:#0f1729;padding:32px 36px"><div style="font-size:22px;font-weight:800;color:#ffffff;margin-bottom:12px">Confirme ton email ⚡</div><div style="font-size:15px;color:rgba(255,255,255,0.6);line-height:1.7;margin-bottom:28px">Salut <strong style="color:#fff">${user.first_name}</strong>,<br/>Voici ton nouveau lien de confirmation.</div><a href="${lien}" style="display:block;background:linear-gradient(135deg,#003FCC,#0057FF);color:#fff;text-align:center;padding:16px 24px;border-radius:50px;font-size:18px;font-weight:900;text-decoration:none;letter-spacing:.02em">CONFIRMER MON EMAIL →</a><div style="margin-top:20px;font-size:12px;color:rgba(255,255,255,0.25);text-align:center">Ce lien expire dans 24h.</div></div><div style="background:#080e1f;padding:18px 36px 24px;border-top:1px solid rgba(255,255,255,0.06)"><div style="font-size:12px;color:rgba(255,255,255,0.2);line-height:1.8">VOLT. Energy · Crissier · Switzerland<br/><a href="mailto:info@volt-energy.ch" style="color:rgba(0,87,255,0.5);text-decoration:none">info@volt-energy.ch</a></div></div></div></div>`
      });
      return res.json({ ok: true });
    } catch(e) { return res.status(500).json({ error: "Erreur: " + e.message }); }
  }

  if (req.method !== "POST") return res.status(405).end();

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
      const [referrer] = await sql`SELECT id FROM users WHERE referral_code = ${ref_code.toUpperCase()}`;
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
      await resend.emails.send({
        from: "VOLT. <noreply@volt-energy.ch>",
        to: u.email,
        subject: "⚡ Confirme ton compte VOLT.",
        html: `<div style="background:#060D2E;padding:40px 20px;font-family:Arial,sans-serif"><div style="max-width:480px;margin:0 auto;border-radius:24px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5)"><div style="background:linear-gradient(135deg,#060D2E 0%,#0A1A5C 40%,#0D2280 70%,#1a3aaa 100%);padding:40px 36px 36px;position:relative;overflow:hidden"><div style="position:absolute;top:0;right:0;width:300px;height:300px;background:radial-gradient(ellipse at 80% 20%,rgba(0,87,255,.6),transparent 70%);pointer-events:none"></div><div style="position:relative;z-index:1"><div style="font-size:64px;font-weight:900;color:#ffffff;letter-spacing:-3px;line-height:1;font-family:Arial Black,Arial,sans-serif">VOLT.</div><div style="font-size:13px;color:rgba(255,255,255,0.45);margin-top:8px;font-weight:600;letter-spacing:.08em;text-transform:uppercase">Système d'accès à l'aide d'un QR code</div></div></div><div style="background:#0f1729;padding:32px 36px"><div style="font-size:22px;font-weight:800;color:#ffffff;margin-bottom:12px">Confirme ton email ⚡</div><div style="font-size:15px;color:rgba(255,255,255,0.6);line-height:1.7;margin-bottom:28px">Salut <strong style="color:#fff">${u.first_name}</strong>,<br/>Clique sur le bouton ci-dessous pour activer ton compte VOLT.</div><a href="${lien}" style="display:block;background:linear-gradient(135deg,#003FCC,#0057FF);color:#fff;text-align:center;padding:16px 24px;border-radius:50px;font-size:18px;font-weight:900;text-decoration:none;letter-spacing:.02em">CONFIRMER MON EMAIL →</a><div style="margin-top:20px;font-size:12px;color:rgba(255,255,255,0.25);text-align:center">Ce lien expire dans 24h. Si tu n'as pas créé de compte, ignore cet email.</div></div><div style="background:#080e1f;padding:18px 36px 24px;border-top:1px solid rgba(255,255,255,0.06)"><div style="font-size:12px;color:rgba(255,255,255,0.2);line-height:1.8">VOLT. Energy · Crissier · Switzerland<br/><a href="mailto:info@volt-energy.ch" style="color:rgba(0,87,255,0.5);text-decoration:none">info@volt-energy.ch</a></div></div></div></div>`
      });
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
    return res.status(500).json({ error: "Erreur: " + e.message });
  }
};
