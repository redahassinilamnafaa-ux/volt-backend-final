const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const Stripe          = require("stripe");

const DUR = { month: 1, quarter: 3, year: 12 };

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const body = req.body || {};

  // ── Stripe webhook events (détectés par structure du body) ─────
  if (body.type && body.data) {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    try {
      switch (body.type) {

        case "invoice.paid": {
          const invoice = body.data.object;
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

        case "customer.subscription.deleted": {
          const subscription = body.data.object;
          await sql`UPDATE users SET subscribed = false WHERE stripe_customer = ${subscription.customer}`;
          break;
        }

        case "payment_intent.succeeded": {
          const pi = body.data.object;
          const userId = pi.metadata?.volt_user_id ? parseInt(pi.metadata.volt_user_id) : null;
          const plan   = pi.metadata?.plan;
          const months = pi.metadata?.months ? parseInt(pi.metadata.months) : null;
          if (userId && plan && months && pi.metadata?.payment_type === "twint") {
            const exp = new Date();
            exp.setMonth(exp.getMonth() + months);
            await sql`UPDATE users SET subscribed = true, plan = ${plan}, sub_expires_at = ${exp} WHERE id = ${userId}`;
            const existing = await sql`SELECT id FROM payments WHERE stripe_payment_id = ${pi.id}`;
            if (!existing.length) {
              await sql`INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status) VALUES (${userId}, ${plan}, ${pi.amount / 100}, ${pi.id}, 'twint', 'success')`;
            }
            const [u] = await sql`SELECT referred_by FROM users WHERE id = ${userId}`;
            if (u?.referred_by) {
              await sql`UPDATE users SET free_months = free_months + 1 WHERE id = ${u.referred_by}`;
            }
          }
          break;
        }

        default: break;
      }
    } catch (e) {
      console.error("Webhook handler error:", e);
      return res.status(500).json({ error: e.message });
    }
    return res.json({ received: true });
  }

  // ── Confirmation de paiement par carte (SetupIntent) ──────────
  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  const { setup_intent_id, payment_method_id, plan_id, customer_id, price_id } = body;
  if (!setup_intent_id || !payment_method_id || !plan_id)
    return res.status(400).json({ error: "Paramètres manquants." });

  const months = DUR[plan_id];
  if (!months) return res.status(400).json({ error: "Plan invalide." });

  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

    await stripe.customers.update(customer_id, {
      invoice_settings: { default_payment_method: payment_method_id },
    });

    const subscription = await stripe.subscriptions.create({
      customer:         customer_id,
      items:            [{ price: price_id }],
      default_payment_method: payment_method_id,
      metadata:         { volt_user_id: auth.id, plan: plan_id },
      expand:           ['latest_invoice.payment_intent'],
    });

    const exp = new Date();
    exp.setMonth(exp.getMonth() + months);
    await sql`
      UPDATE users
      SET subscribed = true,
          plan = ${plan_id},
          sub_expires_at = ${exp}
      WHERE id = ${auth.id}
    `;

    const invoice = subscription.latest_invoice;
    await sql`
      INSERT INTO payments (user_id, plan, amount_chf, stripe_payment_id, method, status)
      VALUES (${auth.id}, ${plan_id}, ${invoice?.amount_paid ? invoice.amount_paid/100 : 0},
              ${subscription.id}, 'card', 'success')
    `;

    const [u] = await sql`SELECT referred_by FROM users WHERE id = ${auth.id}`;
    if (u?.referred_by)
      await sql`UPDATE users SET free_months = free_months + 1 WHERE id = ${u.referred_by}`;

    return res.json({ ok: true, subscription_id: subscription.id });
  } catch(e) {
    return res.status(500).json({ error: "Erreur: " + e.message });
  }
};
