const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const Stripe          = require("stripe");
const stripe          = new Stripe(process.env.STRIPE_SECRET_KEY);
const { sendReceipt } = require("../lib/email");

const DUR = { month: 1, quarter: 3, year: 12 };

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).end();

  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  const { setup_intent_id, payment_method_id, plan_id, customer_id, price_id,
          payment_intent_id, method } = req.body || {};

  // ── TWINT : vérification du PaymentIntent et activation ──────────
  if (method === 'twint') {
    if (!payment_intent_id) return res.status(400).json({ error: "payment_intent_id manquant." });
    try {
      const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
      if (pi.status !== 'succeeded') return res.status(400).json({ error: "Paiement non confirmé." });

      const pidPlan = pi.metadata.plan_id;
      if (String(pi.metadata.volt_user_id) !== String(auth.id))
        return res.status(403).json({ error: "Non autorisé." });

      const months = DUR[pidPlan];
      if (!months) return res.status(400).json({ error: "Plan invalide." });

      const _now = new Date();
      const tYear = _now.getUTCFullYear() + Math.floor((_now.getUTCMonth() + months) / 12);
      const tMonth = (_now.getUTCMonth() + months) % 12;
      const lastDay = new Date(Date.UTC(tYear, tMonth + 1, 0)).getUTCDate();
      const exp = new Date(Date.UTC(tYear, tMonth, Math.min(_now.getUTCDate(), lastDay)));

      const [uBefore] = await sql`SELECT referred_by, subscribed FROM users WHERE id = ${auth.id}`;
      await sql`UPDATE users SET subscribed = true, plan = ${pidPlan}, sub_expires_at = ${exp} WHERE id = ${auth.id}`;
      await sql`
        INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status)
        VALUES (${auth.id}, ${pidPlan}, ${pi.amount / 100}, ${pi.id}, 'twint', 'success')
        ON CONFLICT (stripe_payment_id) DO NOTHING
      `;
      if (uBefore?.referred_by && !uBefore.subscribed)
        await sql`UPDATE users SET free_months = free_months + 1 WHERE id = ${uBefore.referred_by}`;

      const [u2] = await sql`SELECT email, first_name FROM users WHERE id = ${auth.id}`;
      sendReceipt(u2?.email, u2?.first_name || '', pidPlan, pi.amount / 100, exp).catch(() => {});

      return res.json({ ok: true });
    } catch(e) {
      console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." });
    }
  }

  // ── CARTE : vérification du PaymentIntent et création abonnement ──
  if (!payment_intent_id || !plan_id || method !== 'card')
    return res.status(400).json({ error: "Paramètres manquants." });

  const months = DUR[plan_id];
  if (!months) return res.status(400).json({ error: "Plan invalide." });

  try {
    const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (pi.status !== 'succeeded') return res.status(400).json({ error: "Paiement non confirmé." });
    if (String(pi.metadata.volt_user_id) !== String(auth.id))
      return res.status(403).json({ error: "Non autorisé." });

    const pmId = pi.payment_method;
    if (!pmId) return res.status(400).json({ error: "Moyen de paiement manquant." });

    const [u] = await sql`SELECT id, email, first_name, stripe_customer, referred_by, subscribed FROM users WHERE id = ${auth.id}`;
    if (!u) return res.status(404).json({ error: "Utilisateur introuvable." });

    // Attacher le PM au customer pour les renouvellements (si pas déjà attaché)
    try { await stripe.paymentMethods.attach(pmId, { customer: customer_id }); } catch(e) {}
    await stripe.customers.update(customer_id, {
      invoice_settings: { default_payment_method: pmId },
    });

    // Calculer la prochaine date de facturation (fin de la période déjà payée)
    const _now = new Date();
    const tYear  = _now.getUTCFullYear() + Math.floor((_now.getUTCMonth() + months) / 12);
    const tMonth = (_now.getUTCMonth() + months) % 12;
    const lastDay = new Date(Date.UTC(tYear, tMonth + 1, 0)).getUTCDate();
    const exp = new Date(Date.UTC(tYear, tMonth, Math.min(_now.getUTCDate(), lastDay)));

    // Abonnement avec trial_end = fin de la période payée (pas de double facturation)
    const subscription = await stripe.subscriptions.create({
      customer:               customer_id,
      items:                  [{ price: price_id }],
      default_payment_method: pmId,
      trial_end:              Math.floor(exp.getTime() / 1000),
      metadata:               { volt_user_id: String(auth.id), plan: plan_id },
    });

    await sql`UPDATE users SET subscribed = true, plan = ${plan_id}, sub_expires_at = ${exp}, stripe_customer = ${customer_id} WHERE id = ${auth.id}`;

    await sql`
      INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status)
      VALUES (${auth.id}, ${plan_id}, ${pi.amount / 100}, ${pi.id}, 'card', 'success')
      ON CONFLICT (stripe_payment_id) DO NOTHING
    `;

    if (u.referred_by && !u.subscribed)
      await sql`UPDATE users SET free_months = free_months + 1 WHERE id = ${u.referred_by}`;

    sendReceipt(u.email, u.first_name || '', plan_id, pi.amount / 100, exp).catch(() => {});

    return res.json({ ok: true, subscription_id: subscription.id });

  } catch(e) {
    console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." });
  }
};
