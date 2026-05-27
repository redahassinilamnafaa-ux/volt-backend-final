const cors            = require("../../lib/cors");
const sql             = require("../../lib/db");
const { requireAuth } = require("../../lib/auth");
const Stripe          = require("stripe");

const PRICE_IDS = {
  month:   process.env.STRIPE_PRICE_MONTH,
  quarter: process.env.STRIPE_PRICE_QUARTER,
  year:    process.env.STRIPE_PRICE_YEAR,
};

const DUR = { month: 1, quarter: 3, year: 12 };

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  const { plan_id, return_url } = req.body || {};
  const months = DUR[plan_id];
  if (!months) return res.status(400).json({ error: "Plan invalide." });

  const priceId = PRICE_IDS[plan_id];
  if (!priceId) return res.status(400).json({ error: "Prix non configuré pour ce plan." });

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
        metadata: { volt_user_id: String(u.id) },
      });
      customerId = customer.id;
      await sql`UPDATE users SET stripe_customer = ${customerId} WHERE id = ${u.id}`;
    }

    // Récupérer le montant depuis Stripe Price
    const price = await stripe.prices.retrieve(priceId);
    const amount = price.unit_amount;

    // Créer un PaymentIntent TWINT (paiement unique, non récurrent)
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: "chf",
      customer: customerId,
      payment_method_types: ["twint"],
      metadata: {
        volt_user_id: String(u.id),
        plan:         plan_id,
        months:       String(months),
        payment_type: "twint",
      },
      return_url: return_url || "https://energy-volt.vercel.app/VoltApp.html?payment=twint_success",
    });

    return res.json({
      client_secret:      paymentIntent.client_secret,
      payment_intent_id:  paymentIntent.id,
      plan_id,
      amount_chf:         amount / 100,
    });

  } catch (e) {
    return res.status(500).json({ error: "Erreur Stripe TWINT: " + e.message });
  }
};
