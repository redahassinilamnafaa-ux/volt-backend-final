const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM   = 'VOLT. <noreply@volt-energy.ch>';

function escapeHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

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
  const planLabel = escapeHtml(PLAN_LABELS[plan] || plan);
  const expDate   = escapeHtml(new Date(expiresAt).toLocaleDateString('fr-CH', { day: 'numeric', month: 'long', year: 'numeric' }));
  const safeName  = escapeHtml(firstName);

  const html = emailWrapper(`
    <h1 style="font-size:24px;font-weight:800;color:#0A0F1E;margin:0 0 16px;">Paiement confirmé ✓</h1>
    <p style="font-size:15px;color:#2D3652;margin:0 0 28px;">Bonjour ${safeName},<br/>Votre abonnement VOLT. est actif.</p>
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
  const planLabel = escapeHtml(PLAN_LABELS[plan] || plan);
  const expDate   = escapeHtml(new Date(expiresAt).toLocaleDateString('fr-CH', { day: 'numeric', month: 'long', year: 'numeric' }));
  const safeName  = escapeHtml(firstName);

  const html = emailWrapper(`
    <h1 style="font-size:24px;font-weight:800;color:#0A0F1E;margin:0 0 16px;">Votre abonnement expire dans 3 jours</h1>
    <p style="font-size:15px;color:#2D3652;margin:0 0 20px;">Bonjour ${safeName},</p>
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
  const safeName = escapeHtml(firstName);
  const html = emailWrapper(`
    <h1 style="font-size:24px;font-weight:800;color:#0A0F1E;margin:0 0 16px;">Échec du paiement</h1>
    <p style="font-size:15px;color:#2D3652;margin:0 0 20px;">Bonjour ${safeName},</p>
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

/**
 * Signalement envoye par un abonne depuis l'app.
 *
 * Part vers l'adresse de support (SUPPORT_EMAIL, a defaut info@volt-energy.ch)
 * avec `replyTo` sur l'abonne : repondre depuis sa boite suffit a lui ecrire,
 * sans avoir a recopier son adresse.
 */
async function sendIssueReport({ name, email, phone, category, message, gymName, appVersion }) {
  const safe = v => escapeHtml(v || '—');
  const html = emailWrapper(`
    <h1 style="font-size:22px;font-weight:800;color:#0A0F1E;margin:0 0 6px;">Signalement d'un abonné</h1>
    <p style="font-size:14px;color:#6B7A99;margin:0 0 24px;">Envoyé depuis l'application VOLT.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F9FF;border-radius:12px;padding:18px 22px;margin-bottom:22px;">
      <tr><td style="font-size:13px;color:#6B7A99;padding:6px 0;">Abonné</td><td style="font-size:13px;font-weight:700;color:#0A0F1E;text-align:right;padding:6px 0;">${safe(name)}</td></tr>
      <tr><td style="font-size:13px;color:#6B7A99;padding:6px 0;">Email</td><td style="font-size:13px;font-weight:700;color:#0A0F1E;text-align:right;padding:6px 0;">${safe(email)}</td></tr>
      <tr><td style="font-size:13px;color:#6B7A99;padding:6px 0;">Téléphone</td><td style="font-size:13px;font-weight:700;color:#0A0F1E;text-align:right;padding:6px 0;">${safe(phone)}</td></tr>
      <tr><td style="font-size:13px;color:#6B7A99;padding:6px 0;">Fitness</td><td style="font-size:13px;font-weight:700;color:#0A0F1E;text-align:right;padding:6px 0;">${safe(gymName)}</td></tr>
      <tr><td style="font-size:13px;color:#6B7A99;padding:6px 0;">Catégorie</td><td style="font-size:13px;font-weight:700;color:#0A0F1E;text-align:right;padding:6px 0;">${safe(category)}</td></tr>
    </table>
    <div style="font-size:11px;font-weight:700;color:#6B7A99;letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;">Message</div>
    <div style="font-size:15px;color:#2D3652;line-height:1.7;white-space:pre-wrap;background:#ffffff;border:1px solid rgba(0,0,0,.07);border-radius:12px;padding:16px 18px;">${escapeHtml(message)}</div>
    <p style="font-size:12px;color:#6B7A99;margin:22px 0 0;">Répondre à cet email écrit directement à l'abonné.${appVersion ? ' · App ' + escapeHtml(appVersion) : ''}</p>
  `);

  return resend.emails.send({
    from: FROM,
    to: process.env.SUPPORT_EMAIL || 'info@volt-energy.ch',
    replyTo: email || undefined,
    subject: `[Signalement] ${category || 'Problème'} — ${name || email || 'abonné'}`,
    html,
  });
}

/**
 * Bouton « bulletproof » : Outlook rend les emails avec le moteur de Word, qui
 * ignore la plupart des styles CSS et etale les <div> sur toute la largeur.
 * Seule une table imbriquee donne un rendu fiable partout.
 */
function button(href, label) {
  return `
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 auto;">
      <tr><td align="center" bgcolor="#0057FF" style="border-radius:10px;">
        <a href="${href}" style="display:inline-block;padding:15px 34px;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">${label}</a>
      </td></tr>
    </table>`;
}

/** Email de confirmation d'adresse, envoye a l'inscription et au renvoi. */
async function sendVerifyEmail(email, firstName, lien, { resent = false } = {}) {
  const html = emailWrapper(`
    <h1 style="font-size:24px;font-weight:800;color:#0A0F1E;margin:0 0 16px;">Confirme ton email ⚡</h1>
    <p style="font-size:15px;color:#2D3652;line-height:1.7;margin:0 0 28px;">
      Salut <strong>${escapeHtml(firstName)}</strong>,<br/>
      ${resent ? 'Voici ton nouveau lien de confirmation.' : 'Bienvenue chez VOLT. ! Confirme ton adresse pour activer ton compte.'}
    </p>
    ${button(lien, 'CONFIRMER MON EMAIL →')}
    <p style="font-size:13px;color:#6B7A99;line-height:1.6;margin:28px 0 0;text-align:center;">
      Ce lien expire dans 24 heures.<br/>Si tu n'as pas créé de compte, ignore simplement cet email.
    </p>
  `);
  return resend.emails.send({
    from: FROM, to: email,
    subject: '⚡ Confirme ton compte VOLT.',
    html,
  });
}

/** Email de bienvenue, envoye UNE SEULE FOIS, apres confirmation reelle. */
async function sendWelcomeEmail(email, firstName) {
  const html = emailWrapper(`
    <h1 style="font-size:24px;font-weight:800;color:#0A0F1E;margin:0 0 16px;">Bienvenue chez VOLT. ⚡</h1>
    <p style="font-size:15px;color:#2D3652;line-height:1.7;margin:0 0 28px;">
      Salut <strong>${escapeHtml(firstName)}</strong>,<br/>
      Ton compte est <strong style="color:#00A66B;">confirmé et actif</strong>. Tu peux te connecter et profiter de tes boissons.
    </p>
    ${button('https://volt-energy.ch/VoltApp', 'SE CONNECTER →')}
  `);
  return resend.emails.send({
    from: FROM, to: email,
    subject: '⚡ Bienvenue chez VOLT. — Ton compte est actif !',
    html,
  });
}

module.exports = { sendReceipt, sendExpiryReminder, sendFailedPayment, sendIssueReport, sendVerifyEmail, sendWelcomeEmail };
