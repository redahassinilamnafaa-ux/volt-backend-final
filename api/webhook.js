const sql    = require("../lib/db");
const Stripe = require("stripe");
const { sendExpiryReminder, sendFailedPayment } = require("../lib/email");
const { PLAN_MONTHS, computePeriod, ensureSubscriptionColumns } = require("../lib/subscription");

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
        // Période de facturation Stripe : instants fixes, identiques à ceux
        // qu'enregistre pay-confirm.js — les deux chemins ne peuvent plus
        // écrire deux échéances différentes pour un même paiement.
        const periodStart = new Date(subscription.current_period_start * 1000);
        const periodEnd   = new Date(subscription.current_period_end   * 1000);
        const plan = subscription.metadata?.plan;
        const amount = invoice.amount_paid / 100;
        const customerId = invoice.customer;

        await ensureSubscriptionColumns();
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
        if (pi.metadata?.payment_type !== "twint") break;
        const userId = pi.metadata?.volt_user_id ? parseInt(pi.metadata.volt_user_id) : null;
        const planId = pi.metadata?.plan_id;
        if (userId && planId && PLAN_MONTHS[planId]) {
          await sql`
            INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status)
            VALUES (${userId}, ${planId}, ${pi.amount / 100}, ${pi.id}, 'twint', 'success')
            ON CONFLICT (stripe_payment_id) DO NOTHING
          `;
          await ensureSubscriptionColumns();
          const [u] = await sql`SELECT subscribed, sub_expires_at FROM users WHERE id = ${userId}`;
          // Filet de sécurité si le client a fermé l'app avant que pay-confirm
          // ne réponde. Même calcul en mois que pay-confirm.js (et non plus
          // « now + 30 jours »), pour que les deux chemins donnent la même fin.
          if (u && !u.subscribed) {
            const { start, end } = computePeriod(planId);
            await sql`UPDATE users SET subscribed = true, plan = ${planId}, sub_started_at = ${start}, sub_expires_at = ${end} WHERE id = ${userId}`;
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
