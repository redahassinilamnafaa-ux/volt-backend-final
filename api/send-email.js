const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendConfirmationEmail(email, prenom, token) {
  const lien = `https://volt-backend-final-z3ol.vercel.app/api/verify-email?token=${token}`;
  await resend.emails.send({
    from: "VOLT. <onboarding@resend.dev>",
    to: email,
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
              Salut <strong style="color:#fff">${prenom}</strong>,<br/>
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
}

module.exports = { sendConfirmationEmail };
