// Membres : validation des saisies, transitions de pause, sérialisation.
const R = require("./rules");

const MEMBER_SELECT = `
  m.id, m.gym_id, m.prenom, m.nom, m.telephone, m.email, m.naissance::text AS naissance, m.ref_salle,
  m.code_acces, m.debut::text AS debut, m.fin::text AS fin, m.duree, m.statut, m.reprise::text AS reprise,
  m.prolonger, m.motif, m.notes, m.pause_debut::text AS pause_debut, m.pause_ext_applied,
  m.welcome_sent_at, m.created_at, m.updated_at`;

const clip = (v, n = 200) => (v == null ? null : String(v).trim().slice(0, n) || null);

// Accepte 'YYYY-MM-DD' ou 'JJ.MM.AAAA' (imports CSV suisses).
function parseDate(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim();
  const ch = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  const iso = ch ? `${ch[3]}-${ch[2].padStart(2, "0")}-${ch[1].padStart(2, "0")}` : s.slice(0, 10);
  return R.isValidYmd(iso) ? iso : undefined; // undefined = invalide
}

// Valide une création. Renvoie { value } ou { error }.
function validateNew(input) {
  const v = {
    prenom: clip(input.prenom, 80), nom: clip(input.nom, 80),
    telephone: clip(input.telephone, 40), email: clip(input.email, 160)?.toLowerCase() || null,
    code_acces: R.normalizeCode(input.code_acces ?? input.numero_acces),
    naissance: parseDate(input.naissance), ref_salle: clip(input.ref_salle, 60), notes: clip(input.notes, 1000),
    debut: parseDate(input.debut), duree: input.duree ? String(input.duree) : null, fin: parseDate(input.fin),
  };
  if (!v.prenom || !v.nom) return { error: "Prénom et nom obligatoires." };
  if (!v.telephone || !/^[+\d][\d\s./-]{5,}$/.test(v.telephone)) return { error: "Téléphone invalide." };
  if (!v.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) return { error: "Email invalide." };
  if (!v.code_acces) return { error: "N° d'accès invalide (6 à 40 lettres ou chiffres)." };
  if (v.naissance === undefined) return { error: "Date de naissance invalide." };
  if (!v.debut) return { error: "Date de début invalide." };
  if (v.duree) {
    const n = R.parseDuree(v.duree);
    if (!n) return { error: "Durée invalide (1 à 36 mois)." };
    v.fin = R.computeEnd(v.debut, n);
  } else if (!v.fin) {
    return { error: "Durée ou date de fin obligatoire." };
  }
  if (v.fin === undefined) return { error: "Date de fin invalide." };
  if (v.fin < v.debut) return { error: "La date de fin précède le début." };
  return { value: v };
}

// Applique un PATCH sur un membre existant. Renvoie { value: champs à écrire } ou { error }.
function applyPatch(cur, input, today) {
  const next = { ...cur };
  for (const k of ["prenom", "nom", "telephone", "email", "naissance", "ref_salle", "notes", "debut", "fin", "duree", "code_acces"]) {
    if (k in input || (k === "code_acces" && "numero_acces" in input)) next[k] = input[k] ?? input.numero_acces;
  }
  // Re-valider l'identité / l'abonnement avec les règles de création.
  // Fin recalculée depuis la durée, sauf si une date de fin libre est fournie seule.
  const touchedDates = "debut" in input || "duree" in input || "fin" in input;
  const freeEnd = "fin" in input && !("duree" in input);
  const useDuree = touchedDates && !freeEnd && next.duree;
  const { value, error } = validateNew({ ...next, duree: useDuree ? next.duree : null, fin: useDuree ? null : next.fin });
  if (error) return { error };
  value.duree = !touchedDates ? cur.duree : useDuree ? next.duree : null;

  const out = { ...value, statut: cur.statut, reprise: cur.reprise, prolonger: cur.prolonger, motif: cur.motif,
    pause_debut: cur.pause_debut, pause_ext_applied: cur.pause_ext_applied };

  if ("statut" in input) {
    const st = input.statut;
    if (!["actif", "pause", "bloque"].includes(st)) return { error: "Statut invalide." };
    const reprise = "reprise" in input ? parseDate(input.reprise) : out.reprise;
    if (reprise === undefined) return { error: "Date de reprise invalide." };
    const prolonger = "prolonger" in input ? !!input.prolonger : out.prolonger;

    if (st === "pause") {
      if (reprise && reprise <= today) return { error: "La reprise doit être après aujourd'hui." };
      if (cur.statut !== "pause") {
        out.pause_debut = today; out.pause_ext_applied = false;
        if (prolonger && reprise) { out.fin = R.addDays(out.fin, R.daysBetween(today, reprise)); out.pause_ext_applied = true; }
      } else if (out.pause_ext_applied && cur.reprise && reprise && reprise !== cur.reprise) {
        out.fin = R.addDays(out.fin, R.daysBetween(cur.reprise, reprise)); // reprise décalée
      } else if (!out.pause_ext_applied && prolonger && reprise) {
        out.fin = R.addDays(out.fin, R.daysBetween(out.pause_debut || today, reprise)); out.pause_ext_applied = true;
      }
      Object.assign(out, { statut: "pause", reprise, prolonger, motif: null });
    } else {
      if (cur.statut === "pause" && prolonger && !out.pause_ext_applied && out.pause_debut) {
        out.fin = R.addDays(out.fin, Math.max(0, R.daysBetween(out.pause_debut, today))); // reprise manuelle
      }
      Object.assign(out, { statut: st, reprise: null, prolonger: false, pause_debut: null, pause_ext_applied: false,
        motif: st === "bloque" ? clip(input.motif, 200) : null });
      if (st === "bloque" && !out.motif) return { error: "Motif de blocage obligatoire." };
    }
  }
  return { value: out };
}

function serialize(m, today) {
  return {
    id: m.id, prenom: m.prenom, nom: m.nom, telephone: m.telephone, email: m.email, naissance: m.naissance,
    ref_salle: m.ref_salle, code_acces: m.code_acces, debut: m.debut, fin: m.fin, duree: m.duree,
    statut: m.statut, status: R.memberStatus(m, today), reprise: m.reprise, prolonger: m.prolonger, motif: m.motif,
    notes: m.notes, welcome_sent_at: m.welcome_sent_at, created_at: m.created_at,
    last_ok: m.last_ok ?? null, month_count: m.month_count ?? 0,
  };
}

module.exports = { MEMBER_SELECT, parseDate, validateNew, applyPatch, serialize };
