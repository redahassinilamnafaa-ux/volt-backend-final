const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const Stripe          = require("stripe");
const stripe          = new Stripe(process.env.STRIPE_SECRET_KEY);
const { sendReceipt } = require("../lib/email");
const { computeSubscription, monthsForPlan, startOfDayZurich, endOfDayZurich } = require("../lib/subscription");
const { logSubEvent } = require("../lib/subEvents");
const { ensurePaymentsSchema, insertPayment } = require("../lib/payments");

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).end();

  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  const { payment_intent_id, plan_id, customer_id, method } = req.body || {};

  // ── TWINT : vérification du PaymentIntent et activation ──────────
  if (method === 'twint') {
    if (!payment_intent_id) return res.status(400).json({ error: "payment_intent_id manquant." });
    try {
      const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
      if (pi.status !== 'succeeded') return res.status(400).json({ error: "Paiement non confirmé." });

      const pidPlan = pi.metadata.plan_id;
      if (String(pi.metadata.volt_user_id) !== String(auth.id))
        return res.status(403).json({ error: "Non autorisé." });

      if (!monthsForPlan(pidPlan)) return res.status(400).json({ error: "Plan invalide." });

      await ensurePaymentsSchema(sql);

      const [uBefore] = await sql`SELECT referred_by, subscribed, sub_expires_at FROM users WHERE id = ${auth.id}`;

      const { startedAt, expiresAt } = computeSubscription({
        plan: pidPlan,
        currentExpires: uBefore?.sub_expires_at,
        extend: true,               // renouvellement anticipé : le client ne perd pas ses jours restants
      });
      const exp = expiresAt;

      // ── Le paiement s'enregistre AVANT l'activation ────────────────────
      // L'ordre inverse laissait passer le cas suivant : abonnement active,
      // puis echec de l'INSERT -> client abonne mais paiement introuvable dans
      // l'admin, le fitness et l'app. En ecrivant d'abord, un echec ici
      // interrompt tout et rien ne diverge.
      //
      // insertPayment fait aussi office de VERROU d'idempotence : il ne renvoie
      // true qu'a la premiere insertion. Si ce PaymentIntent a deja ete encaisse
      // (par le webhook, ou par un double retour de l'app), on ne recalcule RIEN.
      const isNew = await insertPayment(sql, {
        userId: auth.id, plan: pidPlan, amountChf: pi.amount / 100,
        stripePaymentId: pi.id, method: 'twint',
      });
      if (!isNew) return res.json({ ok: true, already: true });

      await sql`
        UPDATE users
        SET subscribed = true, plan = ${pidPlan},
            sub_started_at = ${startedAt}, sub_expires_at = ${expiresAt}
        WHERE id = ${auth.id}`;
      await logSubEvent(sql, {
        user_id: auth.id, event_type: 'payment', source: 'twint',
        plan: pidPlan, sub_started_at: startedAt, sub_expires_at: expiresAt,
        note: `CHF ${(pi.amount/100).toFixed(2)} — PaymentIntent ${pi.id}`,
      });
      if (uBefore?.referred_by && !uBefore.subscribed && pidPlan === 'year')
        await sql`UPDATE users SET free_months = LEAST(free_months + 1, 12) WHERE id = ${uBefore.referred_by}`;

      const [u2] = await sql`SELECT email, first_name FROM users WHERE id = ${auth.id}`;
      sendReceipt(u2?.email, u2?.first_name || '', pidPlan, pi.amount / 100, exp).catch(() => {});

      return res.json({ ok: true });
    } catch(e) {
      console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." });
    }
  }

  // ── CARTE : vérification du PaymentIntent d'abonnement ───────────
  if (!payment_intent_id || !plan_id)
    return res.status(400).json({ error: "Paramètres manquants." });

  if (!monthsForPlan(plan_id)) return res.status(400).json({ error: "Plan invalide." });

  try {
    const [u] = await sql`SELECT id, email, first_name, stripe_customer, referred_by, subscribed, sub_expires_at FROM users WHERE id = ${auth.id}`;
    if (!u) return res.status(404).json({ error: "Utilisateur introuvable." });

    const pi = await stripe.paymentIntents.retrieve(payment_intent_id, {
      expand: ['invoice.subscription'],
    });
    if (pi.status !== 'succeeded') return res.status(400).json({ error: "Paiement non confirmé." });

    // Vérifier que ce PaymentIntent appartient bien au customer de cet utilisateur
    if (pi.customer !== u.stripe_customer)
      return res.status(403).json({ error: "Non autorisé." });

    await ensurePaymentsSchema(sql);

    const sub = pi.invoice?.subscription;
    let startedAt, exp;
    if (sub) {
      // Abonnement Stripe : Stripe est la source de vérité pour la période.
      startedAt = startOfDayZurich(new Date(sub.current_period_start * 1000));
      exp       = endOfDayZurich(new Date(sub.current_period_end * 1000));
    } else {
      const d = computeSubscription({
        plan: plan_id,
        currentExpires: u.sub_expires_at,
        extend: true,
      });
      startedAt = d.startedAt;
      exp       = d.expiresAt;
    }

    // Paiement d'abord, activation ensuite — meme raison que pour TWINT
    // ci-dessus, et sert de verrou d'idempotence.
    //
    // CLE : pour un paiement d'abonnement, le webhook invoice.paid enregistre
    // sous l'identifiant de la FACTURE. En utilisant pi.id ici, la meme somme
    // etait comptee DEUX fois (une ligne par chemin) et gonflait le CA de
    // l'admin et des fitness. Les deux chemins partagent desormais la meme cle.
    const payKey = pi.invoice?.id || pi.id;
    const isNewCard = await insertPayment(sql, {
      userId: auth.id, plan: plan_id, amountChf: pi.amount / 100,
      stripePaymentId: payKey, method: 'card',
    });
    if (!isNewCard) return res.json({ ok: true, already: true });

    await sql`
      UPDATE users
      SET subscribed = true, plan = ${plan_id},
          sub_started_at = ${startedAt}, sub_expires_at = ${exp},
          stripe_customer = ${u.stripe_customer}
      WHERE id = ${auth.id}`;
    await logSubEvent(sql, {
      user_id: auth.id, event_type: 'payment', source: 'stripe',
      plan: plan_id, sub_started_at: startedAt, sub_expires_at: exp,
      note: `CHF ${(pi.amount/100).toFixed(2)} — PaymentIntent ${pi.id}`,
    });

    if (u.referred_by && !u.subscribed && plan_id === 'year')
      await sql`UPDATE users SET free_months = LEAST(free_months + 1, 12) WHERE id = ${u.referred_by}`;

    sendReceipt(u.email, u.first_name || '', plan_id, pi.amount / 100, exp).catch(() => {});

    return res.json({ ok: true, subscription_id: sub?.id });

  } catch(e) {
    console.error("[api]", e); return res.status(500).json({ error: "Erreur serveur." });
  }
};
