const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM   = 'VOLT. <noreply@volt-energy.ch>';

const PLAN_LABELS = { month: 'Mensuel', quarter: 'Trimestriel', year: 'Annuel' };

function logo() {
  return `<div style="font-family:'Aptos Black Condensed','Aptos Black','Arial Narrow',Impact,sans-serif;font-weight:900;font-stretch:condensed;font-size:32px;letter-spacing:3.1pt;color:#ffffff;margin:0;">VOLT.</div>`;
}

function emailWrapper(content) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#F7F9FF;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F9FF;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;max-width:560px;width:100%;">
        <tr><td style="background:#0A0F1E;padding:28px 40px;">
          ${logo()}
        </td></tr>
        <tr><td style="padding:40px;">
          ${content}
        </td></tr>
        <tr><td style="background:#0A0F1E;padding:20px 40px;text-align:center;">
          <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.4);">© 2026 VOLT. — Reda Hassini · Crissier, Suisse</p>
          <p style="margin:6px 0 0;font-size:12px;"><a href="https://volt-energy.ch" style="color:rgba(255,255,255,0.5);text-decoration:none;">volt-energy.ch</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendReceipt(email, firstName, plan, amountChf, expiresAt) {
  const planLabel = PLAN_LABELS[plan] || plan;
  const expDate   = new Date(expiresAt).toLocaleDateString('fr-CH', { day: 'numeric', month: 'long', year: 'numeric' });

  const html = emailWrapper(`
    <h1 style="font-size:24px;font-weight:800;color:#0A0F1E;margin:0 0 16px;">Paiement confirmé ✓</h1>
    <p style="font-size:15px;color:#2D3652;margin:0 0 28px;">Bonjour ${firstName},<br/>Votre abonnement VOLT. est actif.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F9FF;border-radius:12px;padding:20px 24px;margin-bottom:28px;">
      <tr>
        <td style="font-size:14px;color:#6B7A99;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.05);">Plan</td>
        <td style="font-size:14px;font-weight:700;color:#0A0F1E;text-align:right;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.05);">${planLabel}</td>
      </tr>
      <tr>
        <td style="font-size:14px;color:#6B7A99;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.05);">Montant</td>
        <td style="font-size:14px;font-weight:700;color:#0A0F1E;text-align:right;padding:8px 0;border-bottom:1px solid rgba(0,0,0,0.05);">CHF ${Number(amountChf).toFixed(2)}</td>
      </tr>
      <tr>
        <td style="font-size:14px;color:#6B7A99;padding:8px 0;">Valable jusqu'au</td>
        <td style="font-size:14px;font-weight:700;color:#0A0F1E;text-align:right;padding:8px 0;">${expDate}</td>
      </tr>
    </table>
    <p style="font-size:14px;color:#2D3652;line-height:1.7;margin:0 0 24px;">Votre Code QR est disponible dans l'application. Présentez-le aux distributeurs VOLT. — 1 boisson toutes les 15 minutes.</p>
    <a href="https://volt-energy.ch" style="display:inline-block;background:#0057FF;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:10px;">Accéder à mon compte</a>
  `);

  return resend.emails.send({
    from: FROM,
    to: email,
    subject: `Reçu VOLT. — CHF ${Number(amountChf).toFixed(2)} (${planLabel})`,
    html,
  });
}

async function sendExpiryReminder(email, firstName, plan, expiresAt) {
  const planLabel = PLAN_LABELS[plan] || plan;
  const expDate   = new Date(expiresAt).toLocaleDateString('fr-CH', { day: 'numeric', month: 'long', year: 'numeric' });

  const html = emailWrapper(`
    <h1 style="font-size:24px;font-weight:800;color:#0A0F1E;margin:0 0 16px;">Votre abonnement expire dans 3 jours</h1>
    <p style="font-size:15px;color:#2D3652;margin:0 0 20px;">Bonjour ${firstName},</p>
    <p style="font-size:15px;color:#2D3652;line-height:1.7;margin:0 0 24px;">Votre abonnement <strong>${planLabel}</strong> arrive à expiration le <strong>${expDate}</strong>. Renouvelez-le maintenant pour ne pas perdre l'accès aux distributeurs VOLT.</p>
    <a href="https://volt-energy.ch" style="display:inline-block;background:#0057FF;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:10px;">Renouveler mon abonnement</a>
    <p style="font-size:13px;color:#6B7A99;margin:24px 0 0;">Si votre abonnement est sur renouvellement automatique par carte, aucune action n'est requise.</p>
  `);

  return resend.emails.send({
    from: FROM,
    to: email,
    subject: `Votre abonnement VOLT. expire le ${expDate}`,
    html,
  });
}

async function sendFailedPayment(email, firstName) {
  const html = emailWrapper(`
    <h1 style="font-size:24px;font-weight:800;color:#0A0F1E;margin:0 0 16px;">Échec du paiement</h1>
    <p style="font-size:15px;color:#2D3652;margin:0 0 20px;">Bonjour ${firstName},</p>
    <p style="font-size:15px;color:#2D3652;line-height:1.7;margin:0 0 12px;">Nous n'avons pas pu renouveler votre abonnement VOLT. Votre accès aux distributeurs sera suspendu si le paiement reste en échec.</p>
    <p style="font-size:15px;color:#2D3652;line-height:1.7;margin:0 0 28px;">Veuillez mettre à jour votre moyen de paiement pour rétablir l'accès.</p>
    <a href="https://volt-energy.ch" style="display:inline-block;background:#0057FF;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:10px;">Mettre à jour mon paiement</a>
    <p style="font-size:13px;color:#6B7A99;margin:24px 0 0;">Une question ? Contactez-nous à <a href="mailto:info@volt-energy.ch" style="color:#0057FF;">info@volt-energy.ch</a></p>
  `);

  return resend.emails.send({
    from: FROM,
    to: email,
    subject: 'Paiement VOLT. échoué — action requise',
    html,
  });
}

module.exports = { sendReceipt, sendExpiryReminder, sendFailedPayment };
