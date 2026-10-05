// PDF v1 (pdf-lib) : contrat signé et rapport mensuel. Polices standard (WinAnsi).
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const NAVY = rgb(4 / 255, 28 / 255, 66 / 255);
const RED = rgb(240 / 255, 44 / 255, 56 / 255);
const GREY = rgb(0.35, 0.4, 0.5);
const WINANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

// Remplace les caractères hors WinAnsi (non affichables par les polices standard).
function clean(s) {
  return String(s ?? "")
    .replace(/[−]/g, "-").replace(/[   ]/g, " ").replace(/[→]/g, "->").replace(/[≥]/g, ">=").replace(/[≤]/g, "<=")
    .replace(/[^\n\x20-\x7E¡-ÿ]/g, (c) => (WINANSI_EXTRA.includes(c) ? c : "?"));
}

// HTML du contrat → paragraphes de texte.
function htmlToParagraphs(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>|<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "’")
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

class Writer {
  constructor(doc, fonts) {
    this.doc = doc; this.f = fonts; this.margin = 56; this.page = null; this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([595.28, 841.89]); // A4
    this.y = 841.89 - this.margin;
  }
  ensure(h) { if (this.y - h < this.margin) this.newPage(); }
  wrap(text, font, size, width) {
    const words = clean(text).split(" ");
    const lines = [];
    let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(t, size) > width && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }
  text(text, { size = 10, bold = false, color = NAVY, gap = 4 } = {}) {
    const font = bold ? this.f.bold : this.f.reg;
    const width = 595.28 - this.margin * 2;
    for (const l of this.wrap(text, font, size, width)) {
      this.ensure(size + 3);
      this.page.drawText(l, { x: this.margin, y: this.y - size, size, font, color });
      this.y -= size + 3;
    }
    this.y -= gap;
  }
  brand(subtitle) {
    this.page.drawText("VOLT", { x: this.margin, y: this.y - 26, size: 26, font: this.f.bold, color: NAVY });
    this.page.drawText(".", { x: this.margin + this.f.bold.widthOfTextAtSize("VOLT", 26), y: this.y - 26, size: 26, font: this.f.bold, color: RED });
    this.y -= 36;
    if (subtitle) this.text(subtitle, { size: 9, color: GREY, gap: 14 });
  }
}

async function newDoc() {
  const doc = await PDFDocument.create();
  const fonts = { reg: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  return { doc, w: new Writer(doc, fonts) };
}

const fmtDateTime = (d) => new Date(d).toLocaleString("fr-CH", { timeZone: "Europe/Zurich" });

async function contractPdf({ gym, version, html, signature }) {
  const { doc, w } = await newDoc();
  doc.setTitle(`Contrat de partenariat VOLT. v${version} — ${gym.name}`);
  w.brand(`Contrat de partenariat · version ${version}`);
  for (const para of htmlToParagraphs(html)) w.text(para, { gap: 6 });
  w.ensure(140);
  w.y -= 10;
  w.text("Signature électronique", { size: 12, bold: true, gap: 8 });
  [
    `Salle : ${gym.legal_name || gym.name}`,
    `Signataire : ${signature.signer_name} (${signature.signer_role})`,
    `Date et heure : ${fmtDateTime(signature.signed_at)} (Europe/Zurich)`,
    `Adresse IP : ${signature.ip || "-"}`,
    `Navigateur : ${signature.user_agent || "-"}`,
    `Empreinte SHA-256 du texte : ${signature.text_sha256}`,
    "Authentification : code à usage unique envoyé par email au gérant.",
  ].forEach((l) => w.text(l, { size: 9, gap: 2 }));
  return doc.save();
}

async function monthlyReportPdf({ gym, monthLabel, stats }) {
  const { doc, w } = await newDoc();
  doc.setTitle(`Rapport VOLT. ${monthLabel} — ${gym.name}`);
  w.brand(`Rapport mensuel · ${monthLabel}`);
  w.text(gym.name, { size: 16, bold: true, gap: 14 });
  const rows = [
    ["Boissons distribuées", stats.ok_count],
    ["Refus (délai, badge, statut)", stats.refused_count],
    ["Membres distincts servis", stats.distinct_members],
    ["Membres actifs (fin de mois)", stats.active_members],
    ["Autocontrôles saisis", `${stats.autocontrols} / ${stats.days}`],
    ["Anomalies signalées", stats.anomalies],
    ["Livraisons", stats.deliveries],
  ];
  for (const [k, v] of rows) {
    w.ensure(18);
    w.page.drawText(clean(k), { x: w.margin, y: w.y - 11, size: 11, font: w.f.reg, color: NAVY });
    const val = clean(String(v));
    w.page.drawText(val, { x: 595.28 - w.margin - w.f.bold.widthOfTextAtSize(val, 11), y: w.y - 11, size: 11, font: w.f.bold, color: NAVY });
    w.y -= 22;
  }
  w.y -= 10;
  w.text("Ces chiffres servent de base aux décomptes du partenariat. Les passages détaillés sont conservés 6 mois, les totaux mensuels sans limite.", { size: 9, color: GREY });
  return doc.save();
}

module.exports = { contractPdf, monthlyReportPdf, htmlToParagraphs, clean };
