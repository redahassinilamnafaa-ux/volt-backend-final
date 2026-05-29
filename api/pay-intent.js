const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const Stripe          = require("stripe");

const PRICE_IDS = {
  month:   process.env.STRIPE_PRICE_MONTH,
  quarter: process.env.STRIPE_PRICE_QUARTER,
  year:    process.env.STRIPE_PRICE_YEAR,
};

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).end();

  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  const { plan_id, method, return_url } = req.body || {};
  const priceId = PRICE_IDS[plan_id];
  if (!priceId) return res.status(400).json({ error: "Plan invalide." });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const [u] = await sql`SELECT * FROM users WHERE id = ${auth.id}`;
    if (!u) return res.status(404).json({ error: "Utilisateur introuvable." });

    // Créer ou récupérer le customer Stripe
    let customerId = u.stripe_customer;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: u.email,
        name:  `${u.first_name} ${u.last_name}`,
        metadata: { volt_user_id: u.id },
      });
      customerId = customer.id;
      await sql`UPDATE users SET stripe_customer = ${customerId} WHERE id = ${u.id}`;
    }

    // ── TWINT : PaymentIntent one-time ────────────────────────────────
    if (method === 'twint') {
      const DUR = { month: 1, quarter: 3, year: 12 };
      const price = await stripe.prices.retrieve(priceId);
      const paymentIntent = await stripe.paymentIntents.create({
        amount:   price.unit_amount,
        currency: price.currency,
        customer: customerId,
        payment_method_types: ['twint'],
        metadata: {
          plan_id,
          volt_user_id: String(u.id),
          price_id: priceId,
          payment_type: 'twint',
          months: String(DUR[plan_id] || 1),
        },
        ...(return_url ? { return_url } : {}),
      });
      return res.json({
        client_secret: paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id,
        customer_id: customerId,
        price_id: priceId,
        plan_id,
        method: 'twint',
      });
    }

    // ── CARTE : SetupIntent → Subscription ───────────────────────────
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      metadata: { plan_id, volt_user_id: String(u.id), price_id: priceId },
    });

    return res.json({
      client_secret: setupIntent.client_secret,
      setup_intent_id: setupIntent.id,
      customer_id: customerId,
      price_id: priceId,
      plan_id,
    });

  } catch(e) {
    return res.status(500).json({ error: "Erreur Stripe: " + e.message });
  }
};
