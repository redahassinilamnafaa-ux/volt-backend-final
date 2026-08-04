-- ══════════════════════════════════════════════════════════════════════════════
-- VOLT — Etat des stocks des bornes (bidon d'eau, bacs de poudre)
--
-- POURQUOI. Aucun capteur ne surveille le bidon d'eau exterieur : tous ceux de
-- la carte machine observent les cuves internes et ne reagissent qu'une fois la
-- pompe deja a sec, ce qui la detruit. La tablette tient donc un DECOMPTE
-- (16 L moins le volume de chaque boisson servie) et bloque la distribution
-- avant la panne. Cette table recoit ce decompte, plus les niveaux de bacs qui,
-- eux, etaient deja suivis localement.
--
-- ALIMENTATION. Par api/validate.js, action "commit" : le seul instant ou les
-- niveaux changent. Pas de fonction serverless dediee — le plan Hobby de Vercel
-- plafonne a 12 et le depot y est deja.
--
-- EXECUTION. Ce fichier est documentaire : la table est creee a la volee par
-- api/validate.js et api/admin.js (meme convention que `machines`). Rien a
-- lancer a la main sur Neon. Purement additif.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS machine_levels (
  machine_id        TEXT PRIMARY KEY,
  water_ml          INTEGER,
  water_capacity_ml INTEGER,
  hoppers           JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
