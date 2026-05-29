const sql    = require("../lib/db");
const Stripe = require("stripe");

module.exports = async function handler(req, res) {
  // Pas de CORS restrictif pour les webhooks Stripe
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const event = req.body;
  if (!event || !event.type || !event.data) {
    return res.status(400).json({ error: "Format d'événement invalide." });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  try {
    switch (event.type) {

      // Paiement de facture réussi (abonnement créé ou renouvelé)
      case "invoice.paid": {
        const invoice = event.data.object;
        if (!invoice.subscription) break;

        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        const periodEnd = new Date(subscription.current_period_end * 1000);
        const plan = subscription.metadata?.plan;
        const amount = invoice.amount_paid / 100;
        const customerId = invoice.customer;

        // Mettre à jour subscribed et la vraie date de fin Stripe
        if (plan) {
          await sql`UPDATE users SET subscribed = true, plan = ${plan}, sub_expires_at = ${periodEnd} WHERE stripe_customer = ${customerId}`;
        } else {
          await sql`UPDATE users SET subscribed = true, sub_expires_at = ${periodEnd} WHERE stripe_customer = ${customerId}`;
        }

        // Enregistrer les renouvellements (le premier paiement est enregistré par pay-confirm.js)
        if (invoice.billing_reason === 'subscription_cycle') {
          const [usr] = await sql`SELECT id, plan FROM users WHERE stripe_customer = ${customerId}`;
          if (usr) {
            const existing = await sql`SELECT id FROM payments WHERE stripe_payment_id = ${invoice.id}`;
            if (!existing.length) {
              await sql`INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status) VALUES (${usr.id}, ${usr.plan || 'unknown'}, ${amount}, ${invoice.id}, 'card', 'success')`;
            }
          }
        }
        break;
      }

      // Abonnement supprimé/expiré
      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        await sql`UPDATE users SET subscribed = false WHERE stripe_customer = ${subscription.customer}`;
        break;
      }

      // Paiement TWINT réussi
      case "payment_intent.succeeded": {
        const pi = event.data.object;
        if (pi.metadata?.payment_type !== 'twint') break;

        const userId = pi.metadata?.volt_user_id ? parseInt(pi.metadata.volt_user_id) : null;
        const planId = pi.metadata?.plan_id;
        const DUR_WH = { month: 1, quarter: 3, year: 12 };
        const months = planId ? DUR_WH[planId] : null;

        if (userId && planId && months) {
          const exp = new Date();
          exp.setMonth(exp.getMonth() + months);
          await sql`UPDATE users SET subscribed = true, plan = ${planId}, sub_expires_at = ${exp} WHERE id = ${userId}`;

          const existing = await sql`SELECT id FROM payments WHERE stripe_payment_id = ${pi.id}`;
          if (!existing.length) {
            await sql`INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status) VALUES (${userId}, ${planId}, ${pi.amount / 100}, ${pi.id}, 'twint', 'success')`;
          }

          // Parrainage TWINT
          const [u] = await sql`SELECT referred_by FROM users WHERE id = ${userId}`;
          if (u?.referred_by) {
            await sql`UPDATE users SET free_months = free_months + 1 WHERE id = ${u.referred_by}`;
          }
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
