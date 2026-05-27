const cors = require("../lib/cors");
const sql = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const Stripe = require("stripe");

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    const [u] = await sql`SELECT stripe_customer FROM users WHERE id = ${auth.id}`;
    if (!u || !u.stripe_customer) {
      return res.status(404).json({ error: "Client Stripe introuvable pour ce compte." });
    }

    const subscriptions = await stripe.subscriptions.list({
      customer: u.stripe_customer,
      status: 'active',
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
      return res.status(400).json({ error: "Aucun abonnement actif trouvé pour ce compte." });
    }

    const sub = subscriptions.data[0];

    await stripe.subscriptions.update(sub.id, {
      cancel_at_period_end: true,
    });

    // Mettre à jour sub_expires_at avec la vraie date de fin de période Stripe
    // (évite que l'accès reste actif indéfiniment après la date calculée localement)
    const periodEnd = new Date(sub.current_period_end * 1000);
    await sql`UPDATE users SET sub_expires_at = ${periodEnd} WHERE id = ${auth.id}`;

    return res.json({
      ok: true,
      message: "Abonnement annulé pour la prochaine échéance.",
      period_end: periodEnd.toISOString(),
    });

  } catch (e) {
    return res.status(500).json({ error: "Erreur serveur / Stripe : " + e.message });
  }
};
