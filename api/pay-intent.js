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

  const { plan_id } = req.body || {};
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

    // Créer une SetupIntent pour enregistrer la carte
    // puis créer l'abonnement après confirmation
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      metadata: { plan_id, volt_user_id: u.id, price_id: priceId },
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
