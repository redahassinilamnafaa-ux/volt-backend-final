const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const Stripe          = require("stripe");
const AMOUNTS = { month: 990, quarter: 2490, year: 8990 };
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();
  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });
  const { plan_id } = req.body || {};
  const amount = AMOUNTS[plan_id];
  if (!amount) return res.status(400).json({ error: "Plan invalide." });
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const [u] = await sql`SELECT * FROM users WHERE id = ${auth.id}`;
    if (!u) return res.status(404).json({ error: "Utilisateur introuvable." });
    let cid = u.stripe_customer;
    if (!cid) {
      const c = await stripe.customers.create({ email: u.email, name: `${u.first_name} ${u.last_name}` });
      cid = c.id;
      await sql`UPDATE users SET stripe_customer = ${cid} WHERE id = ${u.id}`;
    }
    const intent = await stripe.paymentIntents.create({ amount, currency: "chf", customer: cid, metadata: { user_id: u.id, plan: plan_id } });
    return res.json({ client_secret: intent.client_secret, id: intent.id });
  } catch (e) {
    return res.status(500).json({ error: "Erreur Stripe: " + e.message });
  }
};
