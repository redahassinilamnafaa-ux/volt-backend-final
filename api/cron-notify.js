const sql     = require("../lib/db");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const expiryHtml = (firstName, daysLeft, expiryDate) =>
  `<div style="background:#040c22;padding:32px 16px;font-family:Arial,sans-serif"><div style="max-width:460px;margin:0 auto"><div style="background:#071433;border-radius:18px;overflow:hidden"><div style="background:#071433;padding:32px 32px 22px;border-bottom:1px solid rgba(0,87,255,.14)"><div style="font-size:50px;font-weight:900;color:#FFFFFF;letter-spacing:-5px;line-height:1;font-family:Arial Black,Arial,sans-serif">VOLT.</div><div style="width:30px;height:3px;background:#FF9500;margin-top:12px;border-radius:2px"></div></div><div style="padding:28px 32px 22px"><div style="font-size:20px;font-weight:800;color:#FFFFFF;margin-bottom:10px">Ton abonnement expire bientôt ⚠️</div><div style="font-size:14px;color:rgba(255,255,255,.55);line-height:1.8;margin-bottom:24px">Salut <strong style="color:#FFFFFF">${firstName}</strong>,<br/>Ton abonnement VOLT. expire le <strong style="color:#FFFFFF">${expiryDate}</strong> (dans <strong style="color:#FF9500">${daysLeft} jours</strong>).<br/>Renouvelle maintenant pour continuer à profiter de tes boissons énergisantes sans interruption.</div><a href="https://volt-energy.ch/VoltApp.html" style="display:block;background:#0057FF;color:#FFFFFF;text-align:center;padding:15px 20px;border-radius:12px;font-size:15px;font-weight:900;text-decoration:none;letter-spacing:.04em;font-family:Arial Black,Arial,sans-serif">RENOUVELER MON ABONNEMENT →</a><div style="font-size:11px;color:rgba(255,255,255,.18);text-align:center;margin-top:16px">Si ton abonnement se renouvelle automatiquement via Stripe, tu n'as rien à faire.</div></div><div style="padding:14px 32px;border-top:1px solid rgba(255,255,255,.05);display:flex;align-items:center;justify-content:space-between"><div style="font-size:18px;font-weight:900;color:rgba(255,255,255,.2);letter-spacing:-2px;font-family:Arial Black,Arial,sans-serif">VOLT.</div><div style="font-size:11px;color:rgba(255,255,255,.18)">Crissier · Switzerland</div></div></div></div></div>`;

module.exports = async function handler(req, res) {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "GET") return res.status(405).end();

  try {
    const rows = await sql`
      SELECT id, first_name, email, sub_expires_at
      FROM users
      WHERE subscribed = true
        AND sub_expires_at IS NOT NULL
        AND sub_expires_at > NOW() + INTERVAL '6 days'
        AND sub_expires_at <= NOW() + INTERVAL '7 days'
    `;

    let sent = 0;
    for (const u of rows) {
      const expDate = new Date(u.sub_expires_at).toLocaleDateString("fr-CH", {
        timeZone: "Europe/Zurich",
        day: "numeric", month: "long", year: "numeric",
      });
      try {
        await resend.emails.send({
          from: "VOLT. <noreply@volt-energy.ch>",
          to: u.email,
          subject: "⚠️ Ton abonnement VOLT. expire dans 7 jours",
          html: expiryHtml(u.first_name, 7, expDate),
        });
        sent++;
      } catch (emailErr) {
        console.error(`cron-notify email error for ${u.email}:`, emailErr);
      }
    }

    return res.json({ ok: true, sent, total: rows.length });
  } catch (e) {
    console.error("cron-notify error:", e);
    return res.status(500).json({ error: e.message });
  }
};
