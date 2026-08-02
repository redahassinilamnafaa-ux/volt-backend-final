-- ══════════════════════════════════════════════════════════════════════════════
-- VOLT — Correction : vends.gym_id doit etre TEXT, pas INTEGER
--
-- La table `vends` a ete creee le 2026-08-02 avec gym_id INTEGER, en copiant le
-- type annonce par la migration de admin.js pour machines.gym_id. Ce type ne
-- reflete pas la colonne REELLEMENT en production (deja existante avant cette
-- migration, jamais recreee par un CREATE TABLE IF NOT EXISTS) : les id de
-- gyms y circulent en UUID. Premier test reel du 2026-08-02 :
--   invalid input syntax for type integer: "dce0e391-39ff-41ef-b5ba-1a2646f87fe8"
--
-- Sans risque : la table vends n'a encore aucune ecriture reussie (tous les
-- essais precedents ont echoue sur cette meme erreur).
--
-- A executer sur Neon APRES 2026-08-02-vends.sql, avant de redeployer le
-- correctif cote backend.
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE vends ALTER COLUMN gym_id TYPE TEXT USING gym_id::text;
