const cors = require("../lib/cors");
const sql  = require("../lib/db");
const { sendWelcomeEmail } = require("../lib/email");

const APP_URL = "https://volt-energy.ch/VoltApp";

/**
 * ══ POURQUOI UNE CONFIRMATION EN DEUX TEMPS ═══════════════════════════════
 *
 * La version precedente validait le compte sur un simple GET, puis SUPPRIMAIT
 * le jeton. Or les messageries d'entreprise (Microsoft Defender / Outlook
 * SafeLinks, tres repandu sur les adresses professionnelles et administratives)
 * PRE-VISITENT automatiquement les liens des emails pour les analyser.
 *
 * Consequence observee en production : le scanner declenchait la confirmation
 * dans la minute suivant l'envoi — compte valide, email de bienvenue expedie —
 * et lorsque l'abonne cliquait vraiment, le jeton n'existait plus : « Lien
 * expire ». Trois symptomes, une seule cause.
 *
 * Un scanner n'emet que des GET. On separe donc :
 *   GET  → affiche une page avec un bouton. Ne modifie RIEN.
 *   POST → confirme reellement, declenche l'email de bienvenue.
 *
 * L'operation est en plus idempotente : un compte deja confirme renvoie la page
 * de succes plutot qu'une erreur, ce qui couvre les doubles clics et les
 * rechargements de page.
 */

function page({ title, message, action, buttonLabel, tone = "ok" }) {
  const accent = tone === "error" ? "#FF3B5C" : "#0057FF";
  return `<!DOCTYPE html><html lang="fr"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>VOLT. — ${title}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       padding:24px;background:linear-gradient(160deg,#060D2E 0%,#0A1A5C 60%,#0D2280 100%);
       font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#fff}
  .card{width:100%;max-width:420px;text-align:center}
  .logo{font-size:46px;font-weight:900;letter-spacing:-2px;margin-bottom:28px}
  .logo span{color:#2979FF}
  h1{font-size:26px;font-weight:800;margin:0 0 14px;line-height:1.25}
  p{font-size:15px;line-height:1.65;color:rgba(255,255,255,.62);margin:0 0 28px}
  .btn{display:block;width:100%;border:0;cursor:pointer;padding:16px 20px;border-radius:14px;
       background:${accent};color:#fff;font-size:15px;font-weight:800;letter-spacing:.03em;
       text-decoration:none;font-family:inherit}
  .btn:active{opacity:.85}
  .link{display:inline-block;margin-top:18px;font-size:13px;color:rgba(255,255,255,.45);text-decoration:none}
</style></head><body>
  <div class="card">
    <div class="logo">VOLT<span>.</span></div>
    <h1>${title}</h1>
    <p>${message}</p>
    ${action
      ? `<form method="POST" action="${action}"><button class="btn" type="submit">${buttonLabel}</button></form>`
      : `<a class="btn" href="${APP_URL}">${buttonLabel}</a>`}
    <a class="link" href="${APP_URL}">Retour à l'application</a>
  </div>
</body></html>`;
}

function send(res, html, status = 200) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Empeche toute mise en cache par un proxy de messagerie.
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).send(html);
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const { token } = req.query;
  if (!token) {
    return send(res, page({
      title: "Lien invalide",
      message: "Ce lien de confirmation est incomplet. Ouvre celui reçu par email.",
      buttonLabel: "Ouvrir l'application", tone: "error",
    }), 400);
  }

  try {
    const [row] = await sql`
      SELECT user_id FROM verify_tokens
      WHERE token = ${token} AND expires_at > NOW()`;

    // Jeton inconnu ou expire : le compte a peut-etre deja ete confirme lors
    // d'une visite precedente, auquel cas ce n'est pas une erreur.
    if (!row) {
      return send(res, page({
        title: "Lien expiré",
        message: "Ce lien n'est plus valide. Connecte-toi à l'application pour en recevoir un nouveau — si ton compte est déjà confirmé, tu peux simplement te connecter.",
        buttonLabel: "Ouvrir l'application", tone: "error",
      }), 410);
    }

    const [user] = await sql`
      SELECT id, email, first_name, email_verified FROM users
      WHERE id::text = ${String(row.user_id)}`;

    if (!user) {
      return send(res, page({
        title: "Compte introuvable",
        message: "Ce compte n'existe plus. Tu peux en créer un nouveau depuis l'application.",
        buttonLabel: "Ouvrir l'application", tone: "error",
      }), 404);
    }

    // ── GET : on n'ecrit RIEN. C'est ce qui rend le lien insensible aux
    //         scanners de messagerie, qui n'emettent jamais de POST.
    if (req.method !== "POST") {
      if (user.email_verified) {
        return send(res, page({
          title: "Compte déjà confirmé",
          message: "Ton adresse est validée. Tu peux te connecter dès maintenant.",
          buttonLabel: "Se connecter",
        }));
      }
      return send(res, page({
        title: "Confirme ton email",
        message: `Dernière étape pour activer ton compte VOLT.<br/><strong style="color:#fff">${user.email}</strong>`,
        action: `/api/verify-email?token=${encodeURIComponent(token)}`,
        buttonLabel: "CONFIRMER MON EMAIL",
      }));
    }

    // ── POST : confirmation reelle, declenchee par l'abonne lui-meme.
    const wasVerified = user.email_verified;
    if (!wasVerified) {
      await sql`UPDATE users SET email_verified = true WHERE id = ${user.id}`;
    }
    // Le jeton n'est supprime qu'ici : tant qu'il vit, un rechargement de page
    // reste sans consequence.
    await sql`DELETE FROM verify_tokens WHERE token = ${token}`;

    // Envoye une seule fois, et jamais avant que l'abonne ait confirme.
    if (!wasVerified) {
      try { await sendWelcomeEmail(user.email, user.first_name || ""); }
      catch (e) { console.error("[verify-email] welcome:", e); }
    }

    return send(res, page({
      title: "Compte confirmé ⚡",
      message: "Ton adresse est validée et ton compte est actif. Bienvenue chez VOLT. !",
      buttonLabel: "Se connecter",
    }));

  } catch (e) {
    console.error("[verify-email]", e);
    return send(res, page({
      title: "Erreur",
      message: "Une erreur est survenue. Réessaie dans quelques instants.",
      buttonLabel: "Ouvrir l'application", tone: "error",
    }), 500);
  }
};
