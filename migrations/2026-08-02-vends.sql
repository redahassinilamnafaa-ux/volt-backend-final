-- ══════════════════════════════════════════════════════════════════════════════
-- VOLT — Table des distributions (remplace l'autorisation MDB sur la borne)
--
-- POURQUOI. L'autorisation de servir passait par le bus MDB entre la carte mere
-- de la machine et le lecteur CM30 : firmware ferme, non instrumentable, sujet
-- aux sessions fantomes et VEND_REQUEST perdus. Le backend devient le point de
-- rendez-vous : la tablette ouvre une distribution, le CM30 l'autorise en
-- scannant (api/validate.js), la tablette la confirme apres distribution reelle
-- (api/vend.js, action commit).
--
-- EFFET DE BORD BENEFIQUE : le cooldown de 15 min et la consommation du token QR
-- ne s'appliquent plus au SCAN mais a la DISTRIBUTION REELLE. Si la machine ne
-- sert pas, le client ne perd ni sa boisson ni son quart d'heure.
--
-- A executer une fois sur la base Neon avant de deployer le nouveau code.
-- Purement additif : ne touche aucune table existante.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vends (
  order_id     TEXT PRIMARY KEY,
  machine_id   TEXT        NOT NULL,
  -- Resolu a l'ouverture depuis machines.gym_id (comme dans validate.js) :
  -- permet a commit() d'ecrire scans/cooldowns avec le meme gym_id que le
  -- reste du systeme (rapports, filtrage par filiale).
  gym_id       INTEGER,
  product_name TEXT,
  amount_cents INTEGER     NOT NULL DEFAULT 0,

  -- PENDING    : la tablette attend un QR
  -- AUTHORIZED : QR valide et RESERVE (ni cooldown ni token consommes)
  -- DISPENSED  : boisson servie, reservation validee
  -- FAILED     : la machine n'a pas servi, reservation liberee
  -- CANCELLED  : abandon client ou retour arriere sur la tablette
  state        TEXT        NOT NULL DEFAULT 'PENDING',

  -- Renseignes a l'autorisation (validate.js), utilises a la validation (commit).
  user_id      TEXT,
  user_name    TEXT,
  qr_token     TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Au-dela, la distribution est caduque : aucun scan ne peut plus l'autoriser.
  expires_at   TIMESTAMPTZ NOT NULL
);

-- Recherche du vend en cours d'une machine : requete du chemin critique,
-- appelee a chaque scan CM30.
CREATE INDEX IF NOT EXISTS vends_machine_state_idx
  ON vends (machine_id, state, expires_at DESC);

-- Purge/supervision.
CREATE INDEX IF NOT EXISTS vends_created_idx ON vends (created_at DESC);
