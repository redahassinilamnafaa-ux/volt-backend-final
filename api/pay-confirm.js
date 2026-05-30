const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const Stripe          = require("stripe");

const DUR = { month: 1, quarter: 3, year: 12 };

module.exports = async function handler(req, res) {
  cors(res);
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
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
      if (pi.status !== 'succeeded') return res.status(400).json({ error: "Paiement non confirmé." });

      const pidPlan = pi.metadata.plan_id;
      if (String(pi.metadata.volt_user_id) !== String(auth.id))
        return res.status(403).json({ error: "Non autorisé." });

      let months = DUR[pidPlan];
      if (!months) return res.status(400).json({ error: "Plan invalide." });
      
      let refCode = pi.metadata.promo_code;
      if (refCode) {
        months += 1; // +1 mois offert pour le nouvel utilisateur !
      }

      const exp = new Date();
      exp.setMonth(exp.getMonth() + months);

      await sql`UPDATE users SET subscribed = true, plan = ${pidPlan}, sub_expires_at = ${exp} WHERE id = ${auth.id}`;
      await sql`
        INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status)
        VALUES (${auth.id}, ${pidPlan}, ${pi.amount / 100}, ${pi.id}, 'twint', 'success')
        ON CONFLICT (stripe_payment_id) DO NOTHING
      `;
      // Credit referrer if promo_code was used
      if (refCode) {
         await sql`UPDATE users SET free_months = free_months + 1 WHERE referral_code = ${refCode}`;
      }

      return res.json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: "Erreur TWINT: " + e.message });
    }
  }

  if (!setup_intent_id || !payment_method_id || !plan_id)
    return res.status(400).json({ error: "Paramètres manquants." });

  const months = DUR[plan_id];
  if (!months) return res.status(400).json({ error: "Plan invalide." });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    // Définir la carte comme méthode de paiement par défaut
    await stripe.customers.update(customer_id, {
      invoice_settings: { default_payment_method: payment_method_id },
    });

    // Créer l'abonnement récurrent
    // Retrieve SetupIntent to check metadata for promo code
    const setupIntent = await stripe.setupIntents.retrieve(setup_intent_id);
    const refCode = setupIntent.metadata.promo_code;
    
    let subParams = {
      customer:         customer_id,
      items:            [{ price: price_id }],
      default_payment_method: payment_method_id,
      metadata:         { volt_user_id: auth.id, plan: plan_id },
      expand:           ['latest_invoice.payment_intent'],
    };
    
    if (refCode) {
      subParams.trial_period_days = 30; // Premier mois gratuit !
    }

    const subscription = await stripe.subscriptions.create(subParams);

    // Calculer la date d'expiration
    const exp = new Date();
    exp.setMonth(exp.getMonth() + months);

    // Mettre à jour l'abonnement en base
    await sql`
      UPDATE users
      SET subscribed = true,
          plan = ${plan_id},
          sub_expires_at = ${exp}
      WHERE id = ${auth.id}
    `;

    // Enregistrer le paiement
    const invoice = subscription.latest_invoice;
    await sql`
      INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status)
      VALUES (${auth.id}, ${plan_id}, ${invoice?.amount_paid ? invoice.amount_paid/100 : 0},
              ${subscription.id}, 'card', 'success')
    `;

    // Credit referrer if promo_code was used
    if (refCode) {
       await sql`UPDATE users SET free_months = free_months + 1 WHERE referral_code = ${refCode}`;
    }

    return res.json({ ok: true, subscription_id: subscription.id });

  } catch(e) {
    return res.status(500).json({ error: "Erreur: " + e.message });
  }
};
