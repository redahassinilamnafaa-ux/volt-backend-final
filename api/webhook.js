const sql    = require("../lib/db");
const Stripe = require("stripe");

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
  if (req.method !== "POST") return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    const rawBody = await getRawBody(req);
    const sig = req.headers["stripe-signature"];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
    } else {
      console.error("[webhook] STRIPE_WEBHOOK_SECRET manquant — définir dans les variables Vercel");
      event = JSON.parse(rawBody.toString());
    }
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
        const periodEnd = new Date(subscription.current_period_end * 1000);
        const plan = subscription.metadata?.plan;
        const amount = invoice.amount_paid / 100;
        const customerId = invoice.customer;

        if (plan) {
          await sql`UPDATE users SET subscribed = true, plan = ${plan}, sub_expires_at = ${periodEnd} WHERE stripe_customer = ${customerId}`;
        } else {
          await sql`UPDATE users SET subscribed = true, sub_expires_at = ${periodEnd} WHERE stripe_customer = ${customerId}`;
        }

        // Enregistrer le paiement (premier paiement + renouvellements)
        const isBillable = invoice.billing_reason === "subscription_cycle" ||
                           invoice.billing_reason === "subscription_create";
        if (isBillable && amount > 0) {
          const [usr] = await sql`SELECT id, plan FROM users WHERE stripe_customer = ${customerId}`;
          if (usr) {
            await sql`
              INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status)
              VALUES (${usr.id}, ${usr.plan || plan || "unknown"}, ${amount}, ${invoice.id}, "card", "success")
              ON CONFLICT (stripe_payment_id) DO NOTHING
            `;
          }
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
        // Le paiement TWINT est traité dans pay-confirm.js (appelé côté client).
        // Ce bloc gère uniquement la persistance en cas d'échec de pay-confirm.
        if (pi.metadata?.payment_type !== "twint") break;
        const userId = pi.metadata?.volt_user_id ? parseInt(pi.metadata.volt_user_id) : null;
        const planId = pi.metadata?.plan_id;
        const DUR_DAYS = { month: 30, quarter: 90, year: 365 };
        const days = planId ? DUR_DAYS[planId] : null;
        if (userId && planId && days) {
          // ON CONFLICT évite le double INSERT si pay-confirm.js a déjà traité
          await sql`
            INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status)
            VALUES (${userId}, ${planId}, ${pi.amount / 100}, ${pi.id}, "twint", "success")
            ON CONFLICT (stripe_payment_id) DO NOTHING
          `;
          // Activer l'abonnement seulement si pas déjà fait par pay-confirm.js
          const [u] = await sql`SELECT subscribed FROM users WHERE id = ${userId}`;
          if (u && !u.subscribed) {
            const exp = new Date(Date.now() + days * 86400000);
            await sql`UPDATE users SET subscribed = true, plan = ${planId}, sub_expires_at = ${exp} WHERE id = ${userId}`;
          }
          // Note : le crédit referral TWINT est géré dans pay-confirm.js (évite le double crédit)
        }
        break;
      }

      default:
        break;
    }
  } catch (e) {
    console.error("Webhook handler error:", e);
    return res.status(500).json({ error: e.message });
  }

  return res.json({ received: true });
};

module.exports.config = { api: { bodyParser: false } };
