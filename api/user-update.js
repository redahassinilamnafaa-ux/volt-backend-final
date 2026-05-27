const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
const Stripe          = require("stripe");
const { Resend }      = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });

  // ── POST /api/user-update → Modifier le profil ─────────────────
  if (req.method === "POST" && !req.query.action) {
    const { firstName, lastName, email, phone } = req.body || {};
    if (!firstName || !lastName || !email)
      return res.status(400).json({ error: "Champs obligatoires manquants." });
    try {
      await sql`
        UPDATE users
        SET first_name = ${firstName},
            last_name  = ${lastName},
            email      = ${email.toLowerCase()},
            phone      = ${phone || null}
        WHERE id = ${auth.id}
      `;
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: "Erreur serveur." });
    }
  }

  // ── DELETE /api/user-update → Supprimer le compte ──────────────
  if (req.method === "DELETE") {
    try {
      // Annuler l'abonnement Stripe si actif (conformité App Store)
      const [userData] = await sql`SELECT stripe_customer FROM users WHERE id = ${auth.id}`;
      if (userData?.stripe_customer) {
        try {
          const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
          const subs = await stripe.subscriptions.list({
            customer: userData.stripe_customer,
            status: 'active',
            limit: 1,
          });
          if (subs.data.length > 0) {
            await stripe.subscriptions.cancel(subs.data[0].id);
          }
        } catch (stripeErr) {
          console.error("Stripe cancel on delete:", stripeErr);
        }
      }

      // Supprimer toutes les données liées au compte
      await sql`DELETE FROM qr_tokens    WHERE user_id = ${String(auth.id)}`;
      await sql`DELETE FROM cooldowns    WHERE user_id = ${auth.id}`;
      await sql`DELETE FROM scans        WHERE user_id = ${auth.id}`;
      await sql`DELETE FROM verify_tokens WHERE user_id = ${String(auth.id)}`;
      await sql`DELETE FROM payments     WHERE user_id = ${auth.id}`;
      await sql`DELETE FROM users        WHERE id      = ${auth.id}`;
      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: "Erreur: " + e.message });
    }
  }

  // ── GET /api/user-update?action=invoices → Liste des factures ───
  if (req.method === "GET" && req.query.action === "invoices") {
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const [u] = await sql`SELECT stripe_customer, email, first_name FROM users WHERE id = ${auth.id}`;
      if (!u || !u.stripe_customer) return res.json({ invoices: [] });

      const stripeInvoices = await stripe.invoices.list({
        customer: u.stripe_customer,
        limit: 24,
        status: "paid",
      });

      const invoices = stripeInvoices.data.map(inv => ({
        id: inv.id,
        number: inv.number,
        amount: (inv.amount_paid / 100).toFixed(2),
        date: new Date(inv.created * 1000).toLocaleDateString("fr-CH"),
        pdf_url: inv.invoice_pdf,
        hosted_url: inv.hosted_invoice_url,
      }));

      return res.json({ invoices });
    } catch (e) {
      return res.status(500).json({ error: "Erreur: " + e.message });
    }
  }

  // ── POST /api/user-update?action=invoices → Envoie facture email ─
  if (req.method === "POST" && req.query.action === "invoices") {
    const { invoice_id } = req.body || {};
    try {
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const [u] = await sql`SELECT stripe_customer, email, first_name FROM users WHERE id = ${auth.id}`;
      if (!u || !u.stripe_customer)
        return res.status(400).json({ error: "Aucun abonnement trouvé." });

      let invoice;
      if (invoice_id) {
        invoice = await stripe.invoices.retrieve(invoice_id);
      } else {
        const list = await stripe.invoices.list({ customer: u.stripe_customer, limit: 1, status: "paid" });
        invoice = list.data[0];
      }

      if (!invoice) return res.status(404).json({ error: "Aucune facture trouvée." });

      const amount  = (invoice.amount_paid / 100).toFixed(2);
      const date    = new Date(invoice.created * 1000).toLocaleDateString("fr-CH");
      const pdfUrl  = invoice.invoice_pdf;
      const hosted  = invoice.hosted_invoice_url;

      await resend.emails.send({
        from: "VOLT. <noreply@volt-energy.ch>",
        to: u.email,
        subject: `🧾 Ta facture VOLT. — CHF ${amount}`,
        html: `<div style="background:#060D2E;padding:40px 20px;font-family:Arial,sans-serif"><div style="max-width:480px;margin:0 auto;border-radius:24px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5)"><div style="background:linear-gradient(135deg,#060D2E 0%,#0A1A5C 40%,#0D2280 70%,#1a3aaa 100%);padding:40px 36px 36px"><div style="font-size:64px;font-weight:900;color:#ffffff;letter-spacing:-3px;line-height:1;font-family:Arial Black,Arial,sans-serif">VOLT.</div></div><div style="background:#0f1729;padding:32px 36px"><div style="font-size:22px;font-weight:800;color:#fff;margin-bottom:20px">Ta facture 🧾</div><div style="font-size:15px;color:rgba(255,255,255,0.6);line-height:1.7;margin-bottom:24px">Salut <strong style="color:#fff">${u.first_name}</strong>,<br/>Voici ta facture VOLT. du <strong style="color:#fff">${date}</strong>.</div><div style="background:rgba(255,255,255,.05);border-radius:16px;padding:20px 24px;margin-bottom:24px;border:1px solid rgba(255,255,255,.08)"><div style="font-size:32px;font-weight:900;color:#fff">CHF ${amount}</div><div style="font-size:13px;color:rgba(255,255,255,.4)">${invoice.number || invoice.id}</div></div><a href="${hosted || pdfUrl}" style="display:block;background:linear-gradient(135deg,#003FCC,#0057FF);color:#fff;text-align:center;padding:16px 24px;border-radius:50px;font-size:18px;font-weight:900;text-decoration:none;margin-bottom:12px">VOIR MA FACTURE →</a>${pdfUrl ? '<a href="'+pdfUrl+'" style="display:block;background:rgba(255,255,255,.06);color:rgba(255,255,255,.6);text-align:center;padding:14px 24px;border-radius:50px;font-size:15px;font-weight:700;text-decoration:none;border:1px solid rgba(255,255,255,.1)">Télécharger PDF ↓</a>' : ''}</div><div style="background:#080e1f;padding:18px 36px 24px;border-top:1px solid rgba(255,255,255,0.06)"><div style="font-size:12px;color:rgba(255,255,255,0.2)">VOLT. Energy · Crissier · Switzerland</div></div></div></div>`
      });

      return res.json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: "Erreur: " + e.message });
    }
  }

  return res.status(405).end();
};
