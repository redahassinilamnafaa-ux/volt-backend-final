const sql    = require("../lib/db");
const Stripe = require("stripe");
const { sendExpiryReminder, sendFailedPayment } = require("../lib/email");
const { computeSubscription, startOfDayZurich, endOfDayZurich } = require("../lib/subscription");
const { logSubEvent } = require("../lib/subEvents");

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── CRON : rappels d'expiration (GET /api/webhook) ───────────────
  if (req.method === "GET") {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || req.headers['authorization'] !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const users = await sql`
        SELECT email, first_name, plan, sub_expires_at
        FROM users
        WHERE subscribed = true
          AND sub_expires_at BETWEEN NOW() + INTERVAL '3 days' AND NOW() + INTERVAL '4 days'
      `;
      await Promise.allSettled(
        users.map(u => sendExpiryReminder(u.email, u.first_name || '', u.plan, u.sub_expires_at))
      );
      return res.json({ ok: true, sent: users.length });
    } catch (e) {
      console.error("[webhook]", e); return res.status(500).json({ error: "Erreur serveur." });
    }
  }

  if (req.method !== "POST") return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    const rawBody = await getRawBody(req);
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!webhookSecret) {
      console.error("[webhook] FATAL: STRIPE_WEBHOOK_SECRET manquant — définir dans les variables Vercel");
      return res.status(500).json({ error: "Configuration webhook manquante." });
    }
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error("[webhook] Signature invalide:", err.message);
    return res.status(400).json({ error: "Webhook Error: " + err.message });
  }

  if (!event || !event.type || !event.data) {
    return res.status(400).json({ error: "Format d'événement invalide." });
  }

  try {
    switch (event.type) {

      case "invoice.paid": {
        const invoice = event.data.object;
        if (!invoice.subscription) break;
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        const periodStart = startOfDayZurich(new Date(subscription.current_period_start * 1000));
        const periodEnd   = endOfDayZurich(new Date(subscription.current_period_end * 1000));
        const plan = subscription.metadata?.plan;
        const amount = invoice.amount_paid / 100;
        const customerId = invoice.customer;

        if (plan) {
          await sql`UPDATE users SET subscribed = true, plan = ${plan}, sub_started_at = ${periodStart}, sub_expires_at = ${periodEnd} WHERE stripe_customer = ${customerId}`;
        } else {
          await sql`UPDATE users SET subscribed = true, sub_started_at = ${periodStart}, sub_expires_at = ${periodEnd} WHERE stripe_customer = ${customerId}`;
        }

        const isBillable = invoice.billing_reason === "subscription_cycle" ||
                           invoice.billing_reason === "subscription_create";
        if (isBillable && amount > 0) {
          const [usr] = await sql`SELECT id, plan FROM users WHERE stripe_customer = ${customerId}`;
          if (usr) {
            await sql`
              INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status)
              VALUES (${usr.id}, ${usr.plan || plan || "unknown"}, ${amount}, ${invoice.id}, 'card', 'success')
              ON CONFLICT (stripe_payment_id) DO NOTHING
            `;
            await logSubEvent(sql, {
              user_id: usr.id,
              event_type: invoice.billing_reason === "subscription_create" ? 'payment' : 'renewal',
              source: 'stripe',
              plan: usr.plan || plan || null,
              sub_started_at: periodStart, sub_expires_at: periodEnd,
              note: `CHF ${amount.toFixed(2)} — Facture Stripe ${invoice.id}`,
            });
          }
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        const [usr] = await sql`SELECT email, first_name FROM users WHERE stripe_customer = ${customerId}`;
        if (usr?.email) {
          sendFailedPayment(usr.email, usr.first_name || '').catch(() => {});
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        await sql`UPDATE users SET subscribed = false WHERE stripe_customer = ${subscription.customer}`;
        break;
      }

      case "payment_intent.succeeded": {
        const pi = event.data.object;
        // twint : achat ponctuel · renew_card : renouvellement anticipe paye
        // par carte, qui est lui aussi un paiement unique et non un abonnement.
        // Les factures d'abonnement, elles, passent par invoice.paid — les
        // traiter ici les compterait deux fois.
        const payType = pi.metadata?.payment_type;
        if (payType !== "twint" && payType !== "renew_card") break;
        const payMethod = payType === "twint" ? "twint" : "card";
        const userId = pi.metadata?.volt_user_id ? parseInt(pi.metadata.volt_user_id) : null;
        const planId = pi.metadata?.plan_id;
        if (userId && planId) {
          // Idempotence : /api/pay-confirm et ce webhook reçoivent le même paiement.
          // La ligne payments fait office de verrou -> un seul des deux calcule les dates.
          const inserted = await sql`
            INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status)
            VALUES (${userId}, ${planId}, ${pi.amount / 100}, ${pi.id}, ${payMethod}, 'success')
            ON CONFLICT (stripe_payment_id) DO NOTHING
            RETURNING id
          `;
          if (inserted.length > 0) {
            const [u] = await sql`SELECT sub_expires_at FROM users WHERE id = ${userId}`;
            try {
              const { startedAt, expiresAt } = computeSubscription({
                plan: planId,
                currentExpires: u?.sub_expires_at,
                extend: true,
              });
              await sql`
                UPDATE users
                SET subscribed = true, plan = ${planId},
                    sub_started_at = ${startedAt}, sub_expires_at = ${expiresAt}
                WHERE id = ${userId}`;
              await logSubEvent(sql, {
                user_id: userId, event_type: 'payment', source: payMethod,
                plan: planId, sub_started_at: startedAt, sub_expires_at: expiresAt,
                note: `CHF ${(pi.amount/100).toFixed(2)} — via webhook Stripe`,
              });
            } catch (planErr) {
              console.error("[webhook] plan inconnu:", planId);
            }
          }
        }
        break;
      }

      default:
        break;
    }
  } catch (e) {
    console.error("[webhook] handler error:", e);
    return res.status(500).json({ error: "Erreur serveur." });
  }

  return res.json({ received: true });
};

module.exports.config = { api: { bodyParser: false } };
