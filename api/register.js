const cors          = require("../lib/cors");
const sql           = require("../lib/db");
const { signToken } = require("../lib/auth");
const bcrypt        = require("bcryptjs");
const { Resend }    = require("resend");
const crypto        = require("crypto");

const resend = new Resend(process.env.RESEND_API_KEY);

const emailHtml = (firstName, lien) => `<div style="background:#040c22;padding:32px 16px;font-family:Arial,sans-serif"><div style="max-width:460px;margin:0 auto"><div style="background:#071433;border-radius:18px;overflow:hidden"><div style="background:#071433;padding:32px 32px 22px;border-bottom:1px solid rgba(0,87,255,.14)"><div style="font-size:50px;font-weight:900;color:#FFFFFF;letter-spacing:-5px;line-height:1;font-family:Arial Black,Arial,sans-serif">VOLT.</div><div style="width:30px;height:3px;background:#0057FF;margin-top:12px;border-radius:2px"></div></div><div style="padding:28px 32px 22px"><div style="font-size:20px;font-weight:800;color:#FFFFFF;margin-bottom:10px">Confirme ton email ⚡</div><div style="font-size:14px;color:rgba(255,255,255,.55);line-height:1.8;margin-bottom:24px">Salut <strong style="color:#FFFFFF">${firstName}</strong>,<br/>Clique sur le bouton ci-dessous pour activer ton compte VOLT. et profiter de tes boissons énergisantes.</div><a href="${lien}" style="display:block;background:#0057FF;color:#FFFFFF;text-align:center;padding:15px 20px;border-radius:12px;font-size:15px;font-weight:900;text-decoration:none;letter-spacing:.04em;font-family:Arial Black,Arial,sans-serif">CONFIRMER MON EMAIL →</a><div style="font-size:11px;color:rgba(255,255,255,.18);text-align:center;margin-top:16px">Ce lien expire dans 24h. Si tu n'as pas créé de compte, ignore cet email.</div></div><div style="padding:14px 32px;border-top:1px solid rgba(255,255,255,.05);display:flex;align-items:center;justify-content:space-between"><div style="font-size:18px;font-weight:900;color:rgba(255,255,255,.2);letter-spacing:-2px;font-family:Arial Black,Arial,sans-serif">VOLT.</div><div style="font-size:11px;color:rgba(255,255,255,.18)">Crissier · Switzerland</div></div></div></div></div>`;

const resendHtml = (firstName, lien) => `<div style="background:#040c22;padding:32px 16px;font-family:Arial,sans-serif"><div style="max-width:460px;margin:0 auto"><div style="background:#071433;border-radius:18px;overflow:hidden"><div style="background:#071433;padding:32px 32px 22px;border-bottom:1px solid rgba(0,87,255,.14)"><div style="font-size:50px;font-weight:900;color:#FFFFFF;letter-spacing:-5px;line-height:1;font-family:Arial Black,Arial,sans-serif">VOLT.</div><div style="width:30px;height:3px;background:#0057FF;margin-top:12px;border-radius:2px"></div></div><div style="padding:28px 32px 22px"><div style="font-size:20px;font-weight:800;color:#FFFFFF;margin-bottom:10px">Confirme ton email ⚡</div><div style="font-size:14px;color:rgba(255,255,255,.55);line-height:1.8;margin-bottom:24px">Salut <strong style="color:#FFFFFF">${firstName}</strong>,<br/>Voici ton nouveau lien de confirmation.</div><a href="${lien}" style="display:block;background:#0057FF;color:#FFFFFF;text-align:center;padding:15px 20px;border-radius:12px;font-size:15px;font-weight:900;text-decoration:none;letter-spacing:.04em;font-family:Arial Black,Arial,sans-serif">CONFIRMER MON EMAIL →</a><div style="font-size:11px;color:rgba(255,255,255,.18);text-align:center;margin-top:16px">Ce lien expire dans 24h.</div></div><div style="padding:14px 32px;border-top:1px solid rgba(255,255,255,.05);display:flex;align-items:center;justify-content:space-between"><div style="font-size:18px;font-weight:900;color:rgba(255,255,255,.2);letter-spacing:-2px;font-family:Arial Black,Arial,sans-serif">VOLT.</div><div style="font-size:11px;color:rgba(255,255,255,.18)">Crissier · Switzerland</div></div></div></div></div>`;

module.exports = async function handler(req, res) {
  cors(res);
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
      await resend.emails.send({
        from: "VOLT. <noreply@volt-energy.ch>",
        to: email,
        subject: "⚡ Confirme ton compte VOLT.",
        html: resendHtml(user.first_name, lien)
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
        html: emailHtml(u.first_name, lien)
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
