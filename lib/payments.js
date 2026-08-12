/**
 * Schema de la table `payments` — garde-fou idempotent.
 *
 * POURQUOI CE FICHIER EXISTE
 * --------------------------
 * Les quatre insertions de paiement du projet utilisaient :
 *
 *     INSERT INTO payments (...) VALUES (...)
 *     ON CONFLICT (stripe_payment_id) DO NOTHING
 *
 * Or `ON CONFLICT (colonne)` EXIGE un index unique sur cette colonne. Aucune
 * migration ne le creait : ni ici, ni dans admin.js (action db-setup), ni
 * ailleurs dans le depot. Sur la base de production l'index n'existait donc
 * pas et Postgres rejetait chaque insertion :
 *
 *     ERROR: there is no unique or exclusion constraint matching
 *            the ON CONFLICT specification
 *
 * Consequence exacte du bug constate : dans pay-confirm.js, le UPDATE users
 * (abonnement active) s'executait AVANT l'INSERT payments. L'abonnement etait
 * donc bien active et l'argent encaisse, mais la ligne de paiement n'arrivait
 * jamais en base -> invisible dans l'admin, dans l'espace fitness et dans
 * l'app. Cote client, `pay-confirm` renvoyait un 500 que l'app ignorait
 * silencieusement : aucune alerte nulle part.
 *
 * Ce module cree la table si besoin, comble les colonnes manquantes, dedoublonne
 * puis pose l'index unique. Il est sur a rejouer : tout est en IF NOT EXISTS.
 */

// Une seule execution par instance chaude (cold start) : inutile de repayer
// le cout de ces requetes a chaque paiement.
let ensured = false;

async function ensurePaymentsSchema(sql) {
  if (ensured) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS payments (
        id                SERIAL PRIMARY KEY,
        user_id           INTEGER,
        plan              VARCHAR(20),
        amount_chf        NUMERIC(10,2),
        stripe_payment_id VARCHAR(255),
        method            VARCHAR(20),
        status            VARCHAR(20) DEFAULT 'success',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;

    // Rattrape une table creee par une version anterieure, sans ces colonnes.
    await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS method     VARCHAR(20)`;
    await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS status     VARCHAR(20) DEFAULT 'success'`;
    await sql`ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;

    // L'index unique refuse de se creer s'il reste des doublons : on nettoie
    // d'abord, en gardant la ligne la plus ancienne de chaque paiement Stripe.
    await sql`
      DELETE FROM payments a USING payments b
      WHERE a.id > b.id
        AND a.stripe_payment_id IS NOT NULL
        AND a.stripe_payment_id = b.stripe_payment_id`;

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS payments_stripe_payment_id_key
      ON payments (stripe_payment_id)`;

    ensured = true;
  } catch (e) {
    // Jamais bloquant : les insertions ci-dessous n'ont plus besoin de l'index
    // (voir insertPayment), il n'est la que comme filet anti-doublon.
    console.warn("[ensurePayments]", e.message);
  }
}

/**
 * Insere un paiement de facon idempotente SANS dependre d'un index unique.
 *
 * `INSERT ... SELECT ... WHERE NOT EXISTS` fonctionne que la contrainte existe
 * ou non : c'est ce qui rend le correctif efficace immediatement, avant meme
 * que la migration ci-dessus ait pu s'appliquer.
 *
 * @returns {Promise<boolean>} true si une nouvelle ligne a ete creee,
 *                             false si ce paiement etait deja enregistre.
 */
async function insertPayment(sql, { userId, plan, amountChf, stripePaymentId, method, status = 'success', createdAt = null }) {
  // createdAt n'est fourni que par la reprise depuis Stripe (admin
  // action=sync-payments) : un paiement rattrape doit garder SA date, sinon
  // tout l'historique se tasserait sur le jour de la reprise et fausserait les
  // virements mensuels. En fonctionnement normal on laisse le DEFAULT NOW().
  const rows = createdAt
    ? await sql`
        INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status, created_at)
        SELECT ${userId}, ${plan}, ${amountChf}, ${stripePaymentId}, ${method}, ${status}, ${createdAt}
        WHERE NOT EXISTS (
          SELECT 1 FROM payments WHERE stripe_payment_id = ${stripePaymentId}
        )
        RETURNING id`
    : await sql`
        INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status)
        SELECT ${userId}, ${plan}, ${amountChf}, ${stripePaymentId}, ${method}, ${status}
        WHERE NOT EXISTS (
          SELECT 1 FROM payments WHERE stripe_payment_id = ${stripePaymentId}
        )
        RETURNING id`;
  return rows.length > 0;
}

module.exports = { ensurePaymentsSchema, insertPayment };
