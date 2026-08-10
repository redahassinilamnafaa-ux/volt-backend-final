const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const Stripe          = require("stripe");
const stripe          = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_IDS = {
  month:   process.env.STRIPE_PRICE_MONTH,
  quarter: process.env.STRIPE_PRICE_QUARTER,
  year:    process.env.STRIPE_PRICE_YEAR,
};

/**
 * Le code est-il encore utilisable ?
 *
 * Verifie explicitement au lieu de se fier au seul filtre `active` : celui-ci
 * reflete l'activation manuelle, pas l'echeance ni le quota. Un code de
 * lancement expire doit etre refuse, meme s'il n'a pas ete desactive a la main.
 */
function isPromoUsable(pc) {
  if (!pc || !pc.coupon || pc.coupon.valid === false) return false;
  if (pc.expires_at && pc.expires_at * 1000 < Date.now()) return false;
  if (pc.max_redemptions && pc.times_redeemed >= pc.max_redemptions) return false;
  return true;
}

/** Montant apres remise, en centimes. Jamais negatif. */
function discounted(amount, coupon) {
  if (!coupon) return amount;
  if (coupon.amount_off)  return Math.max(0, amount - coupon.amount_off);
  if (coupon.percent_off) return Math.round(amount * (100 - coupon.percent_off) / 100);
  return amount;
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).end();

  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  const { plan_id, method, return_url, promo_code, renew } = req.body || {};
  const priceId = PRICE_IDS[plan_id];
  if (!priceId) return res.status(400).json({ error: "Plan invalide." });

  try {
    const [u] = await sql`SELECT * FROM users WHERE id = ${auth.id}`;
    if (!u) return res.status(404).json({ error: "Utilisateur introuvable." });

    // Un code saisi peut etre DEUX choses : un code de lancement (coupon Stripe)
    // ou un code de parrainage (compte d'un autre membre). On cherche d'abord
    // cote Stripe ; a defaut on retombe sur le parrainage, comportement d'origine.
    let coupon = null;
    if (promo_code) {
      const cleanCode = promo_code.trim().toUpperCase();
      const found = await stripe.promotionCodes.list({ code: cleanCode, active: true, limit: 1 });
      const pc = found.data[0];
      if (pc && isPromoUsable(pc)) {
        coupon = pc.coupon;
      } else {
        const [referrer] = await sql`SELECT id FROM users WHERE referral_code = ${cleanCode} AND id != ${auth.id}`;
        if (!referrer) return res.status(400).json({ error: "Le code promo/parrainage est invalide." });
      }
    }

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

    // ── RENOUVELLEMENT ANTICIPE : toujours un paiement UNIQUE ─────────
    //
    // Le client paie la periode suivante avant la fin de la sienne. On ne cree
    // JAMAIS d'abonnement Stripe ici : un abonne par carte en a deja un qui se
    // reconduit seul, et lui en creer un second le ferait prelever deux fois.
    // pay-confirm reconnait un paiement sans abonnement et prolonge la date
    // d'echeance existante (computeSubscription, extend) — le client ne perd
    // donc aucun jour.
    if (renew) {
      const price = await stripe.prices.retrieve(priceId);
      const amount = discounted(price.unit_amount, coupon);
      const isTwint = method === 'twint';
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'chf',
        customer: customerId,
        payment_method_types: [isTwint ? 'twint' : 'card'],
        metadata: {
          plan_id,
          volt_user_id: String(u.id),
          price_id: priceId,
          // Le webhook s'appuie sur ce champ pour activer si l'app se ferme
          // pendant la redirection.
          payment_type: isTwint ? 'twint' : 'renew_card',
          renewal: '1',
          promo_code: coupon ? String(promo_code).trim().toUpperCase() : '',
        },
      });
      return res.json({
        client_secret:     paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id,
        customer_id:       customerId,
        price_id:          priceId,
        plan_id,
        method:            isTwint ? 'twint' : 'card',
        renewal:           true,
        amount_cents:      amount,
        original_cents:    price.unit_amount,
        discount_applied:  Boolean(coupon),
      });
    }

    // ── TWINT : PaymentIntent one-time ────────────────────────────────
    if (method === 'twint') {
      const price = await stripe.prices.retrieve(priceId);
      // Paiement unique : la remise se calcule ici, il n'y a pas d'abonnement
      // Stripe auquel rattacher le coupon. Coherent avec une remise « premiere
      // periode seulement ».
      const amount = discounted(price.unit_amount, coupon);
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'chf',
        customer: customerId,
        payment_method_types: ['twint'],
        metadata: {
          plan_id,
          volt_user_id: String(u.id),
          price_id: priceId,
          payment_type: 'twint',
          promo_code: coupon ? String(promo_code).trim().toUpperCase() : '',
        },
      });
      return res.json({
        client_secret:      paymentIntent.client_secret,
        payment_intent_id:  paymentIntent.id,
        customer_id:        customerId,
        price_id:           priceId,
        plan_id,
        method: 'twint',
        amount_cents:       amount,
        original_cents:     price.unit_amount,
        discount_applied:   Boolean(coupon),
      });
    }

    // ── CARTE : abonnement incomplet → PaymentIntent on-session ──────
    // Annuler les abonnements incomplets existants pour éviter les doublons
    const existingSubs = await stripe.subscriptions.list({
      customer: customerId,
      status:   'incomplete',
      limit:    5,
    });
    for (const sub of existingSubs.data) {
      if (sub.items.data.some(i => i.price.id === priceId)) {
        await stripe.subscriptions.cancel(sub.id);
      }
    }

    // Le coupon est pose sur l'ABONNEMENT : avec un coupon de duree « once »,
    // Stripe l'applique a la premiere facture puis revient au plein tarif tout
    // seul. C'est ce qui donne « 6.90 le premier mois, 9.90 ensuite » sans
    // qu'aucun code n'ait a repasser plus tard.
    const subscription = await stripe.subscriptions.create({
      customer:         customerId,
      items:            [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      metadata:         { volt_user_id: String(u.id), plan_id,
                          promo_code: coupon ? String(promo_code).trim().toUpperCase() : '' },
      expand:           ['latest_invoice.payment_intent'],
      ...(coupon ? { coupon: coupon.id } : {}),
    });

    const paymentIntent = subscription.latest_invoice.payment_intent;
    return res.json({
      client_secret:     paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      subscription_id:   subscription.id,
      customer_id:       customerId,
      price_id:          priceId,
      plan_id,
      method: 'card',
      amount_cents:      subscription.latest_invoice.amount_due,
      discount_applied:  Boolean(coupon),
    });

  } catch (e) {
    console.error("[pay-intent]", e);
    return res.status(500).json({ error: "Erreur Stripe: " + e.message });
  }
};
