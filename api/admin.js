const cors   = require("../lib/cors");
const sql    = require("../lib/db");
const bcrypt = require("bcryptjs");
const { Resend } = require("resend");

const SECRET = process.env.ADMIN_SECRET || "volt-admin-secret-2025";

function auth(req, res) {
  if (req.headers["x-admin-secret"] !== SECRET) {
    res.status(401).json({ error: "Non autorisé." });
    return false;
  }
  return true;
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!auth(req, res)) return;

  const { action } = req.query;

  // ── stats ──────────────────────────────────────────────
  if (action === "stats") {
    try {
      const [[subs],[users],[gyms],[scans],[rm],[rt]] = await Promise.all([
        sql`SELECT COUNT(*) as n FROM users WHERE subscribed=true`,
        sql`SELECT COUNT(*) as n FROM users`,
        sql`SELECT COUNT(*) as n FROM gyms`,
        sql`SELECT COUNT(*) as n FROM scans WHERE scanned_at>NOW()-INTERVAL '30 days'`,
        sql`SELECT COALESCE(SUM(amount_chf),0) as n FROM payments WHERE status='success' AND created_at>NOW()-INTERVAL '30 days'`,
        sql`SELECT COALESCE(SUM(amount_chf),0) as n FROM payments WHERE status='success'`,
      ]);
      return res.json({ subscribers:parseInt(subs.n), total_users:parseInt(users.n), total_gyms:parseInt(gyms.n), scans_month:parseInt(scans.n), rev_month:parseFloat(rm.n), rev_total:parseFloat(rt.n) });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── clients ────────────────────────────────────────────
  if (action === "clients") {
    try {
      const rows = await sql`
        SELECT u.id,u.first_name,u.last_name,u.email,u.plan,u.subscribed,u.authorized,u.email_verified,u.created_at,
          g.name as gym_name, g.filiale as gym_filiale,
          (SELECT COUNT(*) FROM scans s WHERE s.user_id=u.id AND s.scanned_at>NOW()-INTERVAL '30 days') as scans,
          (SELECT COALESCE(SUM(p.amount_chf),0) FROM payments p WHERE p.user_id=u.id AND p.status='success') as revenue
        FROM users u LEFT JOIN gyms g ON u.gym_id=g.id ORDER BY u.created_at DESC`;
      return res.json({ clients: rows.map(c=>({
        id:c.id,
        name:c.first_name+' '+c.last_name,
        email:c.email,
        plan:c.plan,
        subscribed:c.subscribed,
        authorized:c.authorized,
        email_verified:c.email_verified,
        gym:c.gym_name||'—',
        filiale:c.gym_filiale||'',
        scans:parseInt(c.scans)||0,
        revenue:parseFloat(c.revenue)||0,
        joined:new Date(c.created_at).toLocaleDateString('fr-CH',{day:'numeric',month:'short',year:'numeric'})
      })) });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── virements ──────────────────────────────────────────
  if (action === "virements") {
    const ensureVirementTable = async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS virement_status (
          gym_id     INTEGER NOT NULL,
          month_date DATE NOT NULL,
          status     VARCHAR(20) NOT NULL DEFAULT 'paid',
          date_paid  TIMESTAMP DEFAULT NOW(),
          PRIMARY KEY (gym_id, month_date)
        )`;
    };

    if (req.method === "GET") {
      try {
        await ensureVirementTable();
        const rows = await sql`
          SELECT g.id as gym_id, g.name as gym_name,
            TO_CHAR(DATE_TRUNC('month',p.created_at),'Mon. YYYY') as month,
            DATE_TRUNC('month',p.created_at) as month_date,
            COALESCE(SUM(p.amount_chf),0) as total_amount,
            COUNT(p.id) as total_payments,
            vs.status as vs_status, vs.date_paid as vs_date_paid
          FROM payments p
          JOIN users u ON p.user_id = u.id
          JOIN gyms g ON u.gym_id = g.id
          LEFT JOIN virement_status vs ON vs.gym_id = g.id AND vs.month_date = DATE_TRUNC('month', p.created_at)
          WHERE p.status = 'success'
          GROUP BY g.id, g.name, DATE_TRUNC('month', p.created_at), vs.status, vs.date_paid
          ORDER BY month_date DESC, g.name`;

        return res.json({ virements: rows.map(r=>({
          id:`${r.gym_id}-${new Date(r.month_date).toISOString().slice(0,10)}`,
          gym_id:r.gym_id, gym_name:r.gym_name, month:r.month,
          count: parseInt(r.total_payments),
          brut: parseFloat(r.total_amount),
          net: parseFloat(r.total_amount),
          status: r.vs_status || 'pending',
          date_paid: r.vs_date_paid ? new Date(r.vs_date_paid).toISOString() : null
        })) });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    if (req.method === "PUT") {
      const { items, gym_id, month_date, status } = req.body||{};
      try {
        await ensureVirementTable();
        const list = Array.isArray(items) ? items : [{ gym_id, month_date, status }];
        for (const it of list) {
          if (!it.gym_id || !it.month_date) continue;
          const md = String(it.month_date).slice(0,10);
          if (it.status === 'paid') {
            await sql`INSERT INTO virement_status (gym_id, month_date, status, date_paid)
              VALUES (${it.gym_id}, ${md}, 'paid', NOW())
              ON CONFLICT (gym_id, month_date) DO UPDATE SET status='paid', date_paid=NOW()`;
          } else {
            await sql`DELETE FROM virement_status WHERE gym_id=${it.gym_id} AND month_date=${md}`;
          }
        }
        return res.json({ ok:true });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }
  }

  // ── db-setup : migrations complètes ──────────────────
  if (action === "db-setup" && req.method === "POST") {
    const steps = [];
    const run = async (label, query) => {
      try { await query; steps.push({ ok: true, step: label }); }
      catch(e) { steps.push({ ok: false, step: label, error: e.message }); }
    };

    await run("create machines", sql`
      CREATE TABLE IF NOT EXISTS machines (
        id         SERIAL PRIMARY KEY,
        machine_id VARCHAR(100),
        name       VARCHAR(255),
        gym_id     INTEGER,
        secret     VARCHAR(255) NOT NULL DEFAULT 'volt-admin-secret-2025',
        active     BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await run("create sequence", sql`CREATE SEQUENCE IF NOT EXISTS machines_id_seq`);
    await run("attach sequence", sql`ALTER TABLE machines ALTER COLUMN id SET DEFAULT nextval('machines_id_seq')`);

    try {
      const res = await sql`SELECT MAX(id) as maxid FROM machines`;
      const nextId = (res[0]?.maxid || 0) + 1;
      await sql`SELECT setval('machines_id_seq', ${nextId}, false)`;
      steps.push({ ok: true, step: "sync sequence" });
    } catch(e) { steps.push({ ok: false, step: "sync sequence", error: e.message }); }

    await run("machines.machine_id", sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS machine_id VARCHAR(100)`);
    await run("machines.name",       sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS name VARCHAR(255)`);
    await run("machines.gym_id",     sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS gym_id INTEGER`);
    await run("machines.secret",     sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS secret VARCHAR(255) DEFAULT 'volt-admin-secret-2025'`);
    await run("machines.active",     sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
    await run("gyms.filiale",        sql`ALTER TABLE gyms ADD COLUMN IF NOT EXISTS filiale VARCHAR(100)`);
    await run("gyms.active",         sql`ALTER TABLE gyms ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`);
    await run("users.gym_id",        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS gym_id INTEGER`);
    await run("users.authorized",    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS authorized BOOLEAN DEFAULT true`);
    await run("scans.gym_id",        sql`ALTER TABLE scans ADD COLUMN IF NOT EXISTS gym_id INTEGER`);
    await run("scans.machine_id",    sql`ALTER TABLE scans ADD COLUMN IF NOT EXISTS machine_id VARCHAR(100)`);

    return res.json({ ok: steps.every(s => s.ok), steps });
  }

  // ── machines ───────────────────────────────────────────
  if (action === "machines") {
    const ensureMachinesTable = async () => {
      await sql`CREATE TABLE IF NOT EXISTS machines (id SERIAL PRIMARY KEY, machine_id VARCHAR(100), name VARCHAR(255), gym_id INTEGER, secret VARCHAR(255) DEFAULT 'volt-admin-secret-2025', active BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW())`;
    };

    if (req.method === "GET") {
      try {
        await ensureMachinesTable();
        const rows = await sql`SELECT m.*, g.name as gym_name FROM machines m LEFT JOIN gyms g ON m.gym_id = g.id ORDER BY m.created_at DESC`;
        return res.json({ machines: rows });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }

    if (req.method === "POST") {
      const { machine_id, name, gym_id, secret } = req.body||{};
      try {
        await ensureMachinesTable();
        const [m] = await sql`INSERT INTO machines (machine_id, name, gym_id, secret) VALUES (${machine_id}, ${name}, ${gym_id||null}, ${secret||process.env.MACHINE_SECRET||'volt-admin-secret-2025'}) RETURNING *`;
        return res.status(201).json({ ok:true, machine:m });
      } catch(e) { return res.status(500).json({ error:e.message }); }
    }
  }

  return res.status(400).json({ error:"Action inconnue." });
};
