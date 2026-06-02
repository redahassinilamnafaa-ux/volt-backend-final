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

  // ── access (bloquer/débloquer un client) ───────────────
  if (action === "access" && req.method === "POST") {
    const { user_id, authorized } = req.body||{};
    if (!user_id) return res.status(400).json({ error:"user_id requis." });
    try {
      await sql`UPDATE users SET authorized=${authorized} WHERE id=${user_id}`;
      return res.json({ ok:true });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── subscribe (activer/désactiver manuellement) ────────
  if (action === "subscribe" && req.method === "POST") {
    const { user_id, subscribed, plan } = req.body||{};
    if (!user_id) return res.status(400).json({ error:"user_id requis." });
    try {
      if (subscribed) {
        const durMonths = { month:1, quarter:3, year:12 };
        const months = durMonths[plan] || 1;
        const now = new Date();
        const tYear = now.getUTCFullYear() + Math.floor((now.getUTCMonth() + months) / 12);
        const tMonth = (now.getUTCMonth() + months) % 12;
        const lastDay = new Date(Date.UTC(tYear, tMonth + 1, 0)).getUTCDate();
        const exp = new Date(Date.UTC(tYear, tMonth, Math.min(now.getUTCDate(), lastDay)));
        await sql`UPDATE users SET subscribed=true, plan=${plan||'month'}, sub_expires_at=${exp} WHERE id=${user_id}`;
      } else {
        await sql`UPDATE users SET subscribed=false WHERE id=${user_id}`;
      }
      return res.json({ ok:true });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── payments ───────────────────────────────────────────
  if (action === "payments") {
    try {
      const rows = await sql`SELECT p.*,u.first_name,u.last_name FROM payments p LEFT JOIN users u ON p.user_id=u.id ORDER BY p.created_at DESC LIMIT 100`;
      return res.json({ payments: rows.map(p=>({ id:p.id, client:p.first_name+' '+p.last_name, plan:p.plan, amount:parseFloat(p.amount_chf), method:p.method, status:p.status, date:new Date(p.created_at).toLocaleDateString('fr-CH',{day:'numeric',month:'short',year:'numeric'}) })) });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── gyms GET ───────────────────────────────────────────
  if (action === "gyms" && req.method === "GET") {
    try {
      await sql`ALTER TABLE gyms ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`.catch(()=>{});
      const rows = await sql`
        SELECT g.*,
          (SELECT COUNT(*) FROM users u WHERE u.gym_id=g.id AND u.subscribed=true) as members,
          (SELECT COUNT(*) FROM scans s LEFT JOIN users u ON s.user_id=u.id WHERE u.gym_id=g.id AND s.scanned_at>NOW()-INTERVAL '30 days') as scans,
          (SELECT COALESCE(SUM(p.amount_chf),0) FROM payments p LEFT JOIN users u ON p.user_id=u.id WHERE u.gym_id=g.id AND p.status='success' AND p.created_at>NOW()-INTERVAL '30 days') as revenue
        FROM gyms g ORDER BY g.created_at DESC`;
      return res.json({ gyms: rows.map(g=>({ id:g.id, name:g.name, address:g.address, filiale:g.filiale, email:g.email, active:g.active !== false, members:parseInt(g.members)||0, scans:parseInt(g.scans)||0, revenue:parseFloat(g.revenue)||0 })) });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── gyms POST (créer) ──────────────────────────────────
  if (action === "gyms" && req.method === "POST") {
    const { name, address, filiale, email, password } = req.body||{};
    if (!name||!filiale||!email||!password) return res.status(400).json({ error:"Champs manquants." });
    try {
      const hash = await bcrypt.hash(password, 10);
      const [g] = await sql`INSERT INTO gyms (name,address,filiale,email,password) VALUES (${name},${address||null},${filiale},${email.toLowerCase()},${hash}) RETURNING id,name,filiale,email,address`;
      return res.status(201).json({ ok:true, gym:g });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── gyms PUT (modifier) ────────────────────────────────
  if (action === "gyms" && req.method === "PUT") {
    const { id, name, address, filiale, email, password, active } = req.body||{};
    if (!id) return res.status(400).json({ error:"id requis." });
    try {
      await sql`ALTER TABLE gyms ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true`.catch(()=>{});
      // Toggle actif/inactif uniquement
      if (name === undefined && active !== undefined) {
        await sql`UPDATE gyms SET active=${active} WHERE id=${id}`;
        return res.json({ ok:true });
      }
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        await sql`UPDATE gyms SET name=${name},address=${address||null},filiale=${filiale},email=${email.toLowerCase()},password=${hash} WHERE id=${id}`;
      } else {
        await sql`UPDATE gyms SET name=${name},address=${address||null},filiale=${filiale},email=${email.toLowerCase()} WHERE id=${id}`;
      }
      return res.json({ ok:true });
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

  // ── ensure machines table exists ──────────────────────
  const ensureMachinesTable = async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS machines (
        id         SERIAL PRIMARY KEY,
        machine_id VARCHAR(100),
        name       VARCHAR(255),
        gym_id     INTEGER,
        secret     VARCHAR(255) NOT NULL DEFAULT 'volt-admin-secret-2025',
        active     BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    // Ajouter les colonnes manquantes si la table existait déjà sans elles
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS machine_id VARCHAR(100)`.catch(()=>{});
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS name       VARCHAR(255)`.catch(()=>{});
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS gym_id     INTEGER`.catch(()=>{});
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS secret     VARCHAR(255) DEFAULT 'volt-admin-secret-2025'`.catch(()=>{});
    await sql`ALTER TABLE machines ADD COLUMN IF NOT EXISTS active     BOOLEAN DEFAULT true`.catch(()=>{});
    // Colonnes scans
    await sql`ALTER TABLE scans ADD COLUMN IF NOT EXISTS machine_id VARCHAR(100)`.catch(()=>{});
    await sql`ALTER TABLE scans ADD COLUMN IF NOT EXISTS gym_id INTEGER`.catch(()=>{});
  };

  // ── machines GET ───────────────────────────────────────
  if (action === "machines" && req.method === "GET") {
    try {
      await ensureMachinesTable();
      const rows = await sql`
        SELECT m.id, m.machine_id, m.name, m.gym_id, m.secret, m.active,
               g.name as gym_name
        FROM machines m
        LEFT JOIN gyms g ON m.gym_id = g.id
        ORDER BY m.created_at DESC`;
      return res.json({ machines: rows.map(m=>({
        id: m.id, machine_id: m.machine_id, name: m.name,
        gym_id: m.gym_id, gym_name: m.gym_name || null,
        secret: m.secret, active: m.active
      })) });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── machines POST (créer) ──────────────────────────────
  if (action === "machines" && req.method === "POST") {
    const { machine_id, name, gym_id, secret } = req.body||{};
    if (!machine_id||!name) return res.status(400).json({ error:"machine_id et name requis." });
    try {
      await ensureMachinesTable();
      const [m] = await sql`
        INSERT INTO machines (machine_id, name, gym_id, secret)
        VALUES (${machine_id}, ${name}, ${gym_id||null}, ${secret||process.env.MACHINE_SECRET||'volt-admin-secret-2025'})
        RETURNING id, machine_id, name, gym_id, secret`;
      return res.status(201).json({ ok:true, machine:m });
    } catch(e) {
      if (e.code === '23505' || /duplicate|unique/i.test(e.message)) return res.status(409).json({ error:"Ce Machine ID est déjà utilisé." });
      return res.status(500).json({ error:e.message });
    }
  }

  // ── machines PUT (modifier / toggle) ──────────────────
  if (action === "machines" && req.method === "PUT") {
    const { id, machine_id, name, gym_id, secret, active } = req.body||{};
    if (!id) return res.status(400).json({ error:"id requis." });
    try {
      if (machine_id === undefined && name === undefined && active !== undefined) {
        await sql`UPDATE machines SET active=${active} WHERE id=${id}`;
      } else {
        await sql`UPDATE machines SET machine_id=${machine_id}, name=${name}, gym_id=${gym_id||null}, secret=${secret} WHERE id=${id}`;
      }
      return res.json({ ok:true });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── machines DELETE ────────────────────────────────────
  if (action === "machines" && req.method === "DELETE") {
    const { id } = req.body||{};
    if (!id) return res.status(400).json({ error:"id requis." });
    try {
      await sql`DELETE FROM machines WHERE id=${id}`;
      return res.json({ ok:true });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── cron-notify : email J-7 expiration ───────────────
  if (action === "cron-notify" && req.method === "GET") {
    const cronAuth = req.headers.authorization;
    if (process.env.CRON_SECRET && cronAuth !== `Bearer ${process.env.CRON_SECRET}`)
      return res.status(401).json({ error: "Unauthorized" });
    try {
      const rows = await sql`
        SELECT id, first_name, email, sub_expires_at FROM users
        WHERE subscribed = true AND sub_expires_at IS NOT NULL
          AND sub_expires_at > NOW() + INTERVAL '6 days'
          AND sub_expires_at <= NOW() + INTERVAL '7 days'
      `;
      const resend = new Resend(process.env.RESEND_API_KEY);
      let sent = 0;
      for (const u of rows) {
        const expDate = new Date(u.sub_expires_at).toLocaleDateString("fr-CH", { timeZone:"Europe/Zurich", day:"numeric", month:"long", year:"numeric" });
        try {
          await resend.emails.send({ from:"VOLT. <noreply@volt-energy.ch>", to:u.email, subject:"⚠️ Ton abonnement VOLT. expire dans 7 jours", html:`<div style="background:#040c22;padding:32px 16px;font-family:Arial,sans-serif"><div style="max-width:460px;margin:0 auto"><div style="background:#071433;border-radius:18px;overflow:hidden"><div style="background:#071433;padding:32px 32px 22px;border-bottom:1px solid rgba(0,87,255,.14)"><div style="font-size:50px;font-weight:900;color:#fff;letter-spacing:-5px;line-height:1;font-family:Arial Black,Arial,sans-serif">VOLT.</div><div style="width:30px;height:3px;background:#FF9500;margin-top:12px;border-radius:2px"></div></div><div style="padding:28px 32px 22px"><div style="font-size:20px;font-weight:800;color:#fff;margin-bottom:10px">Ton abonnement expire bientôt ⚠️</div><div style="font-size:14px;color:rgba(255,255,255,.55);line-height:1.8;margin-bottom:24px">Salut <strong style="color:#fff">${u.first_name}</strong>,<br/>Ton abonnement expire le <strong style="color:#fff">${expDate}</strong> (dans <strong style="color:#FF9500">7 jours</strong>).</div><a href="https://volt-energy.ch/VoltApp.html" style="display:block;background:#0057FF;color:#fff;text-align:center;padding:15px 20px;border-radius:12px;font-size:15px;font-weight:900;text-decoration:none">RENOUVELER →</a></div><div style="padding:14px 32px;border-top:1px solid rgba(255,255,255,.05)"><div style="font-size:11px;color:rgba(255,255,255,.18)">VOLT. · Crissier · Switzerland</div></div></div></div></div>` });
          sent++;
        } catch(emailErr) { console.error(`cron-notify ${u.email}:`, emailErr); }
      }
      return res.json({ ok:true, sent, total:rows.length });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  return res.status(400).json({ error:"Action inconnue." });
};
