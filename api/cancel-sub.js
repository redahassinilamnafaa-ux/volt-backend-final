const cors = require("../lib/cors");
const sql = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const Stripe = require("stripe");

module.exports = async function handler(req, res) {
  cors(res);
  
  // Gérer la requête préliminaire (preflight) de sécurité CORS
  if (req.method === "OPTIONS") return res.status(200).end();
  
  // Bloquer toute requête qui n'est pas en POST
  if (req.method !== "POST") return res.status(405).end();

  // Vérifier si l'utilisateur est bien connecté
  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    
    // 1. Récupérer le client Stripe associé à l'utilisateur depuis la base de données
    const [u] = await sql`SELECT stripe_customer FROM users WHERE id = ${auth.id}`;
    if (!u || !u.stripe_customer) {
        return res.status(404).json({ error: "Client Stripe introuvable pour ce compte." });
    }

    // 2. Trouver son abonnement actif sur Stripe
    const subscriptions = await stripe.subscriptions.list({
      customer: u.stripe_customer,
      status: 'active',
      limit: 1,
    });

    if (subscriptions.data.length === 0) {
       return res.status(400).json({ error: "Aucun abonnement actif trouvé pour ce compte." });
    }

    const subId = subscriptions.data[0].id;

    // 3. Demander à Stripe d'annuler à la fin de la période déjà payée
    // On met cancel_at_period_end à true plutôt que d'annuler immédiatement
    // Cela permet au client de garder son QR code actif jusqu'à la fin du mois/trimestre payé
    await stripe.subscriptions.update(subId, {
      cancel_at_period_end: true,
    });
    
    return res.json({ ok: true, message: "Abonnement annulé pour la prochaine échéance." });

  } catch(e) {
    return res.status(500).json({ error: "Erreur serveur / Stripe : " + e.message });
  }
};
