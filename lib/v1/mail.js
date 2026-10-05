// Emails v1 (Resend). Chaque envoi est tracé dans emails_log (preuve d'information du membre).
// Aucune donnée membre dans les logs applicatifs : seules les erreurs techniques sont journalisées.
const { Resend } = require("resend");
const db = require("./db");

const FROM = "VOLT. <no-reply@volt-energy.ch>";
const VOLT_EMAIL = () => process.env.VOLT_EMAIL || "info@volt-energy.ch";
const APP_URL = () => (process.env.APP_URL || "https://www.volt-energy.ch").replace(/\/$/, "");

let client = null;
const __setClient = (c) => { client = c; };
const resend = () => (client ||= new Resend(process.env.RESEND_API_KEY));

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function layout(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#EDF1FB;font-family:'Plus Jakarta Sans',Arial,sans-serif;color:#041C42;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#EDF1FB;padding:32px 16px;"><tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:22px;overflow:hidden;">
<tr><td style="background:#041C42;padding:24px 32px;font-size:28px;font-weight:800;letter-spacing:-0.02em;color:#FFFFFF;">VOLT<span style="color:#F02C38;">.</span></td></tr>
<tr><td style="padding:32px;"><h1 style="margin:0 0 16px;font-size:24px;font-weight:800;letter-spacing:-0.03em;">${esc(title)}</h1>${bodyHtml}</td></tr>
<tr><td style="background:#041C42;padding:16px 32px;font-size:12px;color:rgba(255,255,255,.6);text-align:center;">
VOLT. · Crissier, Suisse · <a href="${APP_URL()}" style="color:rgba(255,255,255,.8);">volt-energy.ch</a></td></tr>
</table></td></tr></table></body></html>`;
}

const p = (html) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;">${html}</p>`;
const btn = (href, label) =>
  `<p style="margin:22px 0;"><a href="${esc(href)}" style="display:inline-block;background:#F02C38;color:#FFFFFF;text-decoration:none;font-weight:800;letter-spacing:.04em;text-transform:uppercase;font-size:13px;padding:14px 26px;border-radius:50px;">${esc(label)}</a></p>`;
const list = (items) =>
  `<ul style="margin:0 0 14px;padding-left:20px;font-size:15px;line-height:1.6;">${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;

// Envoi unitaire + trace. Ne lève jamais : renvoie { ok, id?, error? }.
async function send({ kind, to, subject, title, html, text, gym_id = null, member_id = null, attachments }) {
  const sql = db();
  let id = null, error = null;
  try {
    const r = await resend().emails.send({ from: FROM, to, subject, html: layout(title || subject, html), text, attachments });
    if (r.error) error = r.error.message || "Erreur Resend";
    id = r.data?.id || null;
  } catch (e) {
    error = e.message || "Erreur d'envoi";
  }
  if (error) console.error(`[mail] ${kind}: ${error}`);
  await sql`INSERT INTO emails_log (kind, to_email, gym_id, member_id, provider_id, error)
            VALUES (${kind}, ${to}, ${gym_id}, ${member_id}, ${id}, ${error})`;
  return { ok: !error, id, error };
}

// ── Modèles ─────────────────────────────────────────────

function welcomeMember(member, gymName) {
  const text = `Bienvenue ! Ton accès VOLT. chez ${gymName} est actif : une boisson toutes les 15 minutes avec ton badge. Infos et données : volt-energy.ch/confidentialite`;
  return {
    kind: "welcome", to: member.email, member_id: member.id, gym_id: member.gym_id,
    subject: `Ton accès VOLT. chez ${gymName} est actif`,
    title: `Bienvenue, ${member.prenom} !`,
    html: p(`Ton accès VOLT. chez <strong>${esc(gymName)}</strong> est actif : une boisson toutes les 15 minutes avec ton badge.`)
      + p(`Infos et données : <a href="${APP_URL()}/confidentialite" style="color:#F02C38;">volt-energy.ch/confidentialite</a>`),
    text,
  };
}

function sendWelcome(member, gymName) {
  return send(welcomeMember(member, gymName));
}

// Envoi groupé (import) : Resend batch par paquets de 100, chaque email tracé.
async function sendWelcomeBatch(members, gymName) {
  const sql = db();
  const sentIds = [];
  for (let i = 0; i < members.length; i += 100) {
    const chunk = members.slice(i, i + 100).map((m) => welcomeMember(m, gymName));
    let ids = [], error = null;
    try {
      const r = await resend().batch.send(chunk.map((e) => ({ from: FROM, to: e.to, subject: e.subject, html: layout(e.title, e.html), text: e.text })));
      if (r.error) error = r.error.message || "Erreur Resend";
      ids = r.data?.data || r.data || [];
    } catch (e) {
      error = e.message || "Erreur d'envoi";
    }
    if (error) console.error(`[mail] welcome batch: ${error}`);
    for (let j = 0; j < chunk.length; j++) {
      const e = chunk[j];
      await sql`INSERT INTO emails_log (kind, to_email, gym_id, member_id, provider_id, error)
                VALUES ('welcome', ${e.to}, ${e.gym_id}, ${e.member_id}, ${ids[j]?.id || null}, ${error})`;
      if (!error) sentIds.push(e.member_id);
    }
  }
  return sentIds;
}

function sendPasswordReset(user, token) {
  const link = `${APP_URL()}/fitness?reset=${encodeURIComponent(token)}`;
  return send({
    kind: "password_reset", to: user.email, gym_id: user.gym_id,
    subject: "Réinitialiser ton mot de passe VOLT.",
    title: "Mot de passe oublié",
    html: p("Tu as demandé à réinitialiser le mot de passe de ton Espace fitness VOLT.")
      + btn(link, "Choisir un nouveau mot de passe")
      + p("Ce lien est valable 1 heure. Si tu n'as rien demandé, ignore cet email."),
    text: `Réinitialiser ton mot de passe VOLT. (lien valable 1 heure) : ${link}`,
  });
}

function sendContractOtp(to, code, gym) {
  return send({
    kind: "contract_otp", to, gym_id: gym.id,
    subject: `Code de signature VOLT. : ${code}`,
    title: "Ton code de signature",
    html: p(`Code pour signer le contrat de partenariat VOLT. au nom de <strong>${esc(gym.name)}</strong> :`)
      + `<p style="margin:18px 0;font-size:34px;font-weight:800;letter-spacing:.2em;">${code}</p>`
      + p("Valable 10 minutes. Si tu n'es pas à l'origine de cette demande, préviens-nous."),
    text: `Code de signature VOLT. : ${code} (valable 10 minutes)`,
  });
}

function sendContractSigned(to, gym, sig, pdf) {
  return send({
    kind: "contract_signed", to, gym_id: gym.id,
    subject: `Contrat de partenariat VOLT. signé — ${gym.name}`,
    title: "Contrat signé",
    html: p(`Le contrat de partenariat VOLT. (version ${esc(sig.version)}) a été signé par <strong>${esc(sig.signer_name)}</strong> (${esc(sig.signer_role)}) pour <strong>${esc(gym.name)}</strong>.`)
      + p("Le PDF signé est joint à cet email."),
    text: `Contrat VOLT. v${sig.version} signé par ${sig.signer_name} pour ${gym.name}. PDF joint.`,
    attachments: [{ filename: `contrat-volt-${sig.version}.pdf`, content: Buffer.from(pdf).toString("base64") }],
  });
}

function sendAnomaly(gym, a, station, photo) {
  const rows = [
    `Salle : <strong>${esc(gym.name)}</strong>`,
    station ? `Station : ${esc(station.name)}` : null,
    `Type : <strong>${esc(a.type)}</strong>`,
    `Constat : ${esc(a.description)}`,
    a.saveur ? `Saveur : ${esc(a.saveur)}` : null,
    a.lot ? `N° de lot : ${esc(a.lot)}` : null,
    `Station mise hors service : ${a.station_off ? "oui" : "non"}`,
    `Poche conservée : ${a.pouch_kept ? "oui" : "non"}`,
  ].filter(Boolean);
  return send({
    kind: "anomaly", to: VOLT_EMAIL(), gym_id: gym.id,
    subject: `⚠ Anomalie autocontrôle — ${gym.name} — ${a.type}`,
    title: "Anomalie signalée",
    html: list(rows) + (photo ? p("Photo jointe.") : ""),
    text: rows.join("\n").replace(/<[^>]+>/g, ""),
    attachments: photo ? [{ filename: photo.filename, content: photo.base64 }] : undefined,
  });
}

function sendIntervention(gym, station, message, user) {
  return send({
    kind: "intervention", to: VOLT_EMAIL(), gym_id: gym.id,
    subject: `Demande d'intervention — ${gym.name} — ${station.name}`,
    title: "Demande d'intervention",
    html: list([`Salle : <strong>${esc(gym.name)}</strong>`, `Station : ${esc(station.name)}`, `Demandé par : ${esc(user)}`])
      + p(esc(message || "(aucun message)")),
    text: `Demande d'intervention — ${gym.name} — ${station.name}\n${message || ""}`,
  });
}

function sendGymDaily(to, gym, expiring, missingAutocontrol) {
  const parts = [];
  if (expiring.length) {
    parts.push(p(`<strong>${expiring.length} abonnement${expiring.length > 1 ? "s" : ""}</strong> expire${expiring.length > 1 ? "nt" : ""} dans 14 jours :`));
    parts.push(list(expiring.map((m) => `${esc(m.prenom)} ${esc(m.nom)} — fin le ${m.fin.split("-").reverse().join(".")}`)));
  }
  if (missingAutocontrol) parts.push(p(`<strong>L'autocontrôle d'hier n'a pas été saisi.</strong> Tu peux encore le compléter (jusqu'à 7 jours en arrière).`));
  parts.push(btn(`${APP_URL()}/fitness`, "Ouvrir l'Espace fitness"));
  return send({
    kind: "gym_daily", to, gym_id: gym.id,
    subject: `VOLT. — À faire aujourd'hui · ${gym.name}`,
    title: "À faire aujourd'hui",
    html: parts.join(""),
    text: `${expiring.length} abonnement(s) expirent dans 14 jours.${missingAutocontrol ? " Autocontrôle d'hier manquant." : ""}`,
  });
}

function sendAdminRecap({ deliveries, maintenances, offline }) {
  const sec = (t, items) => (items.length ? p(`<strong>${t}</strong>`) + list(items.map(esc)) : "");
  return send({
    kind: "admin_recap", to: VOLT_EMAIL(),
    subject: "VOLT. — Récap du jour",
    title: "Récap du jour",
    html: sec("Livraisons sous 7 jours", deliveries) + sec("Entretiens dus sous 14 jours", maintenances) + sec("Stations hors ligne > 2 h", offline),
    text: [...deliveries, ...maintenances, ...offline].join("\n"),
  });
}

function sendMonthlyReport(to, gym, monthLabel, pdf, filename) {
  return send({
    kind: "monthly_report", to, gym_id: gym.id,
    subject: `VOLT. — Rapport ${monthLabel} · ${gym.name}`,
    title: `Rapport ${monthLabel}`,
    html: p(`Le rapport mensuel VOLT. de <strong>${esc(gym.name)}</strong> pour ${esc(monthLabel)} est joint (passages, membres actifs, autocontrôles, livraisons).`),
    text: `Rapport mensuel VOLT. ${monthLabel} — ${gym.name}. PDF joint.`,
    attachments: [{ filename, content: Buffer.from(pdf).toString("base64") }],
  });
}

module.exports = {
  VOLT_EMAIL, APP_URL, send, sendWelcome, sendWelcomeBatch, sendPasswordReset, sendContractOtp,
  sendContractSigned, sendAnomaly, sendIntervention, sendGymDaily, sendAdminRecap, sendMonthlyReport,
  __setClient,
};
