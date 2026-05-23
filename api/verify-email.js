const cors       = require("../lib/cors");
const sql        = require("../lib/db");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

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
      return res.redirect("https://energy-volt.vercel.app/VoltApp.html?verify=expired");
    }

    const user_id = tokens[0].user_id;

    const users = await sql`
      SELECT id, email, first_name FROM users
      WHERE id::text = ${user_id}
    `;

    if (!users.length) {
      return res.redirect("https://energy-volt.vercel.app/VoltApp.html?verify=expired");
    }

    const { id, email, first_name } = users[0];

    await sql`UPDATE users SET email_verified = true WHERE id = ${id}`;
    await sql`DELETE FROM verify_tokens WHERE token = ${token}`;

    try {
      await resend.emails.send({
        from: "VOLT. <noreply@volt-energy.ch>",
        to: email,
        subject: "⚡ Bienvenue chez VOLT. — Ton compte est actif !",
        html: `<div style="background:#060D2E;padding:40px 20px;font-family:Arial,sans-serif"><div style="max-width:480px;margin:0 auto;border-radius:24px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5)"><div style="background:linear-gradient(135deg,#060D2E 0%,#0A1A5C 40%,#0D2280 70%,#1a3aaa 100%);padding:40px 36px 36px;position:relative;overflow:hidden"><div style="position:absolute;top:0;right:0;width:300px;height:300px;background:radial-gradient(ellipse at 80% 20%,rgba(0,87,255,.6),transparent 70%);pointer-events:none"></div><div style="position:relative;z-index:1"><div style="font-size:64px;font-weight:900;color:#ffffff;letter-spacing:-3px;line-height:1;font-family:Arial Black,Arial,sans-serif">VOLT.</div><div style="font-size:13px;color:rgba(255,255,255,0.45);margin-top:8px;font-weight:600;letter-spacing:.08em;text-transform:uppercase">Système d'accès à l'aide d'un QR code</div></div></div><div style="background:#0f1729;padding:32px 36px"><div style="font-size:22px;font-weight:800;color:#ffffff;margin-bottom:12px">Bienvenue dans la zone VOLT. ⚡</div><div style="font-size:15px;color:rgba(255,255,255,0.6);line-height:1.8;margin-bottom:24px">Salut <strong style="color:#fff">${first_name}</strong> 👋<br/><br/>Ton compte est <strong style="color:#00C47A">confirmé et actif</strong>. Connecte-toi pour accéder à VOLT.</div><a href="https://energy-volt.vercel.app/VoltApp.html" style="display:block;background:linear-gradient(135deg,#003FCC,#0057FF);color:#fff;text-align:center;padding:16px 24px;border-radius:50px;font-size:18px;font-weight:900;text-decoration:none;letter-spacing:.02em">SE CONNECTER →</a></div><div style="background:#080e1f;padding:18px 36px 24px;border-top:1px solid rgba(255,255,255,0.06)"><div style="font-size:12px;color:rgba(255,255,255,0.2);line-height:1.8">VOLT. Energy · Crissier · Switzerland<br/><a href="mailto:info@volt-energy.ch" style="color:rgba(0,87,255,0.5);text-decoration:none">info@volt-energy.ch</a></div></div></div></div>`
      });
    } catch(e) {
      console.error("Welcome email error:", e);
    }

    return res.redirect("https://energy-volt.vercel.app/VoltApp.html?verify=success");

  } catch(e) {
    console.error("verify-email error:", e);
    return res.status(500).json({ error: "Erreur: " + e.message });
  }
};
