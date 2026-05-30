const cors       = require("../lib/cors");
const sql        = require("../lib/db");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const welcomeHtml = (firstName) => `<div style="background:#040c22;padding:32px 16px;font-family:Arial,sans-serif"><div style="max-width:460px;margin:0 auto"><div style="background:#071433;border-radius:18px;overflow:hidden"><div style="background:#071433;padding:32px 32px 22px;border-bottom:1px solid rgba(0,87,255,.14)"><div style="font-size:50px;font-weight:900;color:#FFFFFF;letter-spacing:-5px;line-height:1;font-family:Arial Black,Arial,sans-serif">VOLT.</div><div style="width:30px;height:3px;background:#0057FF;margin-top:12px;border-radius:2px"></div></div><div style="padding:28px 32px 22px"><div style="font-size:20px;font-weight:800;color:#FFFFFF;margin-bottom:10px">Bienvenue chez VOLT. ⚡</div><div style="font-size:14px;color:rgba(255,255,255,.55);line-height:1.8;margin-bottom:24px">Salut <strong style="color:#FFFFFF">${firstName}</strong>,<br/>Ton compte est <strong style="color:#00C47A">confirmé et actif</strong>. Tu peux maintenant te connecter et profiter de tes boissons énergisantes.</div><a href="https://volt-energy.ch/VoltApp.html" style="display:block;background:#0057FF;color:#FFFFFF;text-align:center;padding:15px 20px;border-radius:12px;font-size:15px;font-weight:900;text-decoration:none;letter-spacing:.04em;font-family:Arial Black,Arial,sans-serif">SE CONNECTER →</a></div><div style="padding:14px 32px;border-top:1px solid rgba(255,255,255,.05);display:flex;align-items:center;justify-content:space-between"><div style="font-size:18px;font-weight:900;color:rgba(255,255,255,.2);letter-spacing:-2px;font-family:Arial Black,Arial,sans-serif">VOLT.</div><div style="font-size:11px;color:rgba(255,255,255,.18)">Crissier · Switzerland</div></div></div></div></div>`;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const { token } = req.query;
  if (!token) return res.status(400).send("Token manquant.");

  try {
    const tokens = await sql`
      SELECT * FROM verify_tokens
      WHERE token = ${token}
      AND expires_at > NOW()
    `;

    if (!tokens.length) {
      return res.redirect("https://volt-energy.ch/VoltApp.html?verify=expired");
    }

    const user_id = tokens[0].user_id;

    const users = await sql`
      SELECT id, email, first_name FROM users
      WHERE id::text = ${user_id}
    `;

    if (!users.length) {
      return res.redirect("https://volt-energy.ch/VoltApp.html?verify=expired");
    }

    const { id, email, first_name } = users[0];

    await sql`UPDATE users SET email_verified = true WHERE id = ${id}`;
    await sql`DELETE FROM verify_tokens WHERE token = ${token}`;

    try {
      await resend.emails.send({
        from: "VOLT. <noreply@volt-energy.ch>",
        to: email,
        subject: "⚡ Bienvenue chez VOLT. — Ton compte est actif !",
        html: welcomeHtml(first_name)
      });
    } catch(e) {
      console.error("Welcome email error:", e);
    }

    return res.redirect("https://volt-energy.ch/VoltApp.html?verify=success");

  } catch(e) {
    console.error("verify-email error:", e);
    return res.status(500).json({ error: "Erreur: " + e.message });
  }
};
