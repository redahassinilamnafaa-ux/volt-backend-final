/**
 * VOLT. — Historique lisible des abonnements.
 * Chaque activation, résiliation, paiement ou renouvellement laisse une ligne,
 * jamais modifiée après coup. Sert à éviter toute confusion sur "qui a changé
 * quoi et quand" (utilisé par admin.js, pay-confirm.js, webhook.js, user-update.js).
 */

async function ensureSubEventsTable(sql) {
  await sql`CREATE TABLE IF NOT EXISTS subscription_events (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,     -- 'admin_activate' | 'admin_cancel' | 'payment' | 'renewal' | 'referral_bonus' | 'expired'
    source TEXT NOT NULL,         -- 'admin' | 'stripe' | 'twint' | 'system'
    plan TEXT,
    days INTEGER,
    sub_started_at TIMESTAMPTZ,
    sub_expires_at TIMESTAMPTZ,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`.catch(() => {});
}

async function logSubEvent(sql, { user_id, event_type, source, plan = null, days = null, sub_started_at = null, sub_expires_at = null, note = null }) {
  try {
    await ensureSubEventsTable(sql);
    await sql`
      INSERT INTO subscription_events (user_id, event_type, source, plan, days, sub_started_at, sub_expires_at, note)
      VALUES (${user_id}, ${event_type}, ${source}, ${plan}, ${days}, ${sub_started_at}, ${sub_expires_at}, ${note})`;
  } catch (e) {
    // La journalisation ne doit jamais faire échouer l'action métier elle-même.
    console.error("[sub-history] échec de journalisation:", e);
  }
}

module.exports = { ensureSubEventsTable, logSubEvent };
