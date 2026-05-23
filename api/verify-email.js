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
    // Cherche le token sans jointure d'abord
    const tokens = await sql`
      SELECT * FROM verify_tokens
      WHERE token = ${token}
      AND expires_at > NOW()
    `;

    if (!tokens.length) {
      return res.redirect("https://energy-volt.vercel.app?verify=expired");
    }

    const { user_id } = tokens[0];

    // Cherche l'utilisateur séparément
    const users = await sql`
      SELECT id, email, first_name FROM users WHERE id = ${parseInt(user_id)}
    `;

    if (!users.length) {
      return res.redirect("https://energy-volt.vercel.app?verify=expired");
    }

    const { id, email, first_name } = users[0];

    // Met à jour et supprime le token
    await sql`UPDATE users SET email_verified = true WHERE id = ${id}`;
    await sql`DELETE FROM verify_tokens WHERE token = ${token}`;

    // Email de bienvenue
    try {
      await resend.emails.send({
        from: "VOLT. <onboarding@resend.dev>",
        to: email,
        subject: "⚡ Bienvenue chez VOLT. — Ton compte est actif !",
        html: `
          <div style="background:#0A0F1E;padding:40px 20px;font-family:Arial,sans-serif">
            <div style="max-width:480px;margin:0 auto;background:#111827;border-radius:20px;overflow:hidden">
              <div style="background:linear-gradient(135deg,#003FCC,#2979FF);padding:32px 36px">
                <div style="font-size:48px;font-weight:900;color:#fff;letter-spacing:-2px">VOLT.</div>
                <div style="font-size:24px;font-weight:800;color:#fff;margin-top:14px;line-height:1.2">Bienvenue dans<br/>la zone VOLT. ⚡</div>
              </div>
              <div style="padding:32px 36px">
                <div style="font-size:15px;color:rgba(255,255,255,0.6);line-height:1.8;margin-bottom:24px">
                  Salut <strong style="color:#fff">${first_name}</strong> 👋<br/><br/>
                  Ton compte est <strong style="color:#00C47A">confirmé et actif</strong>. Choisis ton abonnement pour accéder aux machines VOLT. en un scan.
                </div>
                <a href="https://energy-volt.vercel.app" style="display:block;background:#0057FF;color:#fff;text-align:center;padding:15px 24px;border-radius:50px;font-size:17px;font-weight:900;text-decoration:none">
                  ACCÉDER À MON COMPTE →
                </a>
              </div>
              <div style="padding:16px 36px 28px;border-top:1px solid rgba(255,255,255,0.05)">
                <div style="font-size:12px;color:rgba(255,255,255,0.2)">VOLT. Energy · Genève · info@volt.energy.ch</div>
              </div>
            </div>
          </div>
        `
      });
    } catch(e) {
      console.error("Welcome email error:", e);
    }

    return res.redirect("https://energy-volt.vercel.app?verify=success");

  } catch(e) {
    console.error("verify-email error:", e);
    return res.status(500).json({ error: "Erreur: " + e.message });
  }
};
