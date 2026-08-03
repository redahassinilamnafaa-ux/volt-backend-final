-- ══════════════════════════════════════════════════════════════════════════════
-- VOLT — users.sub_started_at : date de DÉBUT d'abonnement
--
-- POURQUOI. Seule la fin (sub_expires_at) était enregistrée, et chaque chemin
-- d'activation la recalculait a partir de NOW() au moment de l'ecriture. Une
-- reactivation admin repoussait donc l'echeance, et l'app cliente, faute de
-- date de debut, retombait sur `new Date()` : l'echeance affichee avancait d'un
-- jour chaque jour. Impossible aussi de repondre a « depuis quand ce client
-- est-il abonne ? ».
--
-- Desormais la periode est calculee UNE FOIS a l'activation (admin sans
-- paiement, carte, TWINT) puis stockee telle quelle. Aucun chemin de lecture ne
-- la recalcule. Voir lib/subscription.js.
--
-- Purement additif. api/admin.js applique deja cet ALTER a la volee
-- (ensureSubscriptionColumns) : ce fichier sert de trace et permet de
-- l'executer manuellement sur Neon.
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_started_at TIMESTAMPTZ;

-- Retro-remplissage des abonnements existants : on remonte de la duree de la
-- formule depuis la fin enregistree. Approximatif pour les anciens paiements
-- TWINT (fin calculee en « +30/90/365 jours »), exact pour tous les autres.
-- Ne touche que les lignes sans date de debut.
UPDATE users
SET sub_started_at = sub_expires_at - (
      CASE plan
        WHEN 'year'    THEN INTERVAL '12 months'
        WHEN 'quarter' THEN INTERVAL '3 months'
        ELSE                INTERVAL '1 month'
      END)
WHERE sub_started_at IS NULL
  AND sub_expires_at IS NOT NULL;

-- Tableaux admin/fitness : tri et filtrage par periode d'abonnement.
CREATE INDEX IF NOT EXISTS users_sub_period_idx
  ON users (sub_expires_at DESC, sub_started_at DESC);
