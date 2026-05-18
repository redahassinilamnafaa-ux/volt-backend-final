const cors   = require("../lib/cors");
const sql    = require("../lib/db");
const bcrypt = require("bcryptjs");

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
      const [subs]  = await sql`SELECT COUNT(*) as n FROM users WHERE subscribed=true`;
      const [users] = await sql`SELECT COUNT(*) as n FROM users`;
      const [gyms]  = await sql`SELECT COUNT(*) as n FROM gyms`;
      const [scans] = await sql`SELECT COUNT(*) as n FROM scans WHERE scanned_at>NOW()-INTERVAL '30 days'`;
      const [rm]    = await sql`SELECT COALESCE(SUM(amount_chf),0) as n FROM payments WHERE status='success' AND created_at>NOW()-INTERVAL '30 days'`;
      const [rt]    = await sql`SELECT COALESCE(SUM(amount_chf),0) as n FROM payments WHERE status='success'`;
      return res.json({ subscribers:parseInt(subs.n), total_users:parseInt(users.n), total_gyms:parseInt(gyms.n), scans_month:parseInt(scans.n), rev_month:parseFloat(rm.n), rev_total:parseFloat(rt.n) });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── clients ────────────────────────────────────────────
  if (action === "clients") {
    try {
      const rows = await sql`
        SELECT u.id,u.first_name,u.last_name,u.email,u.plan,u.subscribed,u.authorized,u.created_at,
          g.name as gym_name,
          (SELECT COUNT(*) FROM scans s WHERE s.user_id=u.id AND s.scanned_at>NOW()-INTERVAL '30 days') as scans,
          (SELECT COALESCE(SUM(p.amount_chf),0) FROM payments p WHERE p.user_id=u.id AND p.status='success') as revenue
        FROM users u LEFT JOIN gyms g ON u.gym_id=g.id ORDER BY u.created_at DESC`;
      return res.json({ clients: rows.map(c=>({ id:c.id, name:c.first_name+' '+c.last_name, email:c.email, plan:c.plan, subscribed:c.subscribed, authorized:c.authorized, gym:c.gym_name||'—', scans:parseInt(c.scans)||0, revenue:parseFloat(c.revenue)||0, joined:new Date(c.created_at).toLocaleDateString('fr-CH',{day:'numeric',month:'short',year:'numeric'}) })) });
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
      const rows = await sql`
        SELECT g.*,
          (SELECT COUNT(*) FROM users u WHERE u.gym_id=g.id AND u.subscribed=true) as members,
          (SELECT COUNT(*) FROM scans s LEFT JOIN users u ON s.user_id=u.id WHERE u.gym_id=g.id AND s.scanned_at>NOW()-INTERVAL '30 days') as scans,
          (SELECT COALESCE(SUM(p.amount_chf),0) FROM payments p LEFT JOIN users u ON p.user_id=u.id WHERE u.gym_id=g.id AND p.status='success' AND p.created_at>NOW()-INTERVAL '30 days') as revenue
        FROM gyms g ORDER BY g.created_at DESC`;
      return res.json({ gyms: rows.map(g=>({ id:g.id, name:g.name, address:g.address, filiale:g.filiale, email:g.email, active:true, members:parseInt(g.members)||0, scans:parseInt(g.scans)||0, revenue:parseFloat(g.revenue)||0 })) });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── gyms POST (créer) ──────────────────────────────────
  if (action === "gyms" && req.method === "POST") {
    const { name, address, filiale, email, password } = req.body||{};
    if (!name||!filiale||!email||!password) return res.status(400).json({ error:"Champs manquants." });
    try {
      const hash = await bcrypt.hash(password, 10);
      const [g] = await sql`INSERT INTO gyms (name,address,filiale,email,password) VALUES (${name},${address||null},${filiale},${email.toLowerCase()},${hash}) RETURNING id,name,filiale,email`;
      return res.status(201).json({ ok:true, gym:g });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── gyms PUT (modifier) ────────────────────────────────
  if (action === "gyms" && req.method === "PUT") {
    const { id, name, filiale, email, password } = req.body||{};
    if (!id) return res.status(400).json({ error:"id requis." });
    try {
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        await sql`UPDATE gyms SET name=${name},filiale=${filiale},email=${email.toLowerCase()},password=${hash} WHERE id=${id}`;
      } else {
        await sql`UPDATE gyms SET name=${name},filiale=${filiale},email=${email.toLowerCase()} WHERE id=${id}`;
      }
      return res.json({ ok:true });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  // ── virements ──────────────────────────────────────────
  if (action === "virements") {
    try {
      const rows = await sql`
        SELECT g.id as gym_id, g.name as gym_name,
          TO_CHAR(DATE_TRUNC('month',p.created_at),'Mon. YYYY') as month,
          DATE_TRUNC('month',p.created_at) as month_date,
          COALESCE(SUM(p.amount_chf),0) as total
        FROM payments p
        LEFT JOIN users u ON p.user_id=u.id
        LEFT JOIN gyms g ON u.gym_id=g.id
        WHERE p.status='success' AND g.id IS NOT NULL
        GROUP BY g.id,g.name,DATE_TRUNC('month',p.created_at)
        ORDER BY month_date DESC,g.name`;
      return res.json({ virements: rows.map((r,i)=>({ id:'v'+(i+1), gym_id:r.gym_id, gym_name:r.gym_name, month:r.month, brut:parseFloat(r.total), net:parseFloat(r.total), status:'pending', date_paid:null })) });
    } catch(e) { return res.status(500).json({ error:e.message }); }
  }

  return res.status(400).json({ error:"Action inconnue." });
};
