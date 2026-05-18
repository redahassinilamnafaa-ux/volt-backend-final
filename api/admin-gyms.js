const cors   = require("../lib/cors");
const sql    = require("../lib/db");
const bcrypt = require("bcryptjs");

const ADMIN_SECRET = process.env.ADMIN_SECRET || "volt-admin-secret-2025";

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.headers["x-admin-secret"] !== ADMIN_SECRET)
    return res.status(401).json({ error: "Non autorisé." });

  // GET — liste des fitness
  if (req.method === "GET") {
    try {
      const gyms = await sql`
        SELECT g.*,
          (SELECT COUNT(*) FROM users u WHERE u.gym_id = g.id AND u.subscribed = true) as members,
          (SELECT COUNT(*) FROM scans s LEFT JOIN users u ON s.user_id = u.id
           WHERE u.gym_id = g.id AND s.scanned_at > NOW() - INTERVAL '30 days') as scans,
          (SELECT COALESCE(SUM(p.amount_chf),0) FROM payments p LEFT JOIN users u ON p.user_id = u.id
           WHERE u.gym_id = g.id AND p.status='success'
           AND p.created_at > NOW() - INTERVAL '30 days') as revenue
        FROM gyms g ORDER BY g.created_at DESC
      `;

      return res.json({
        gyms: gyms.map(g => ({
          id:      g.id,
          name:    g.name,
          address: g.address,
          filiale: g.filiale,
          email:   g.email,
          active:  true,
          members: parseInt(g.members) || 0,
          scans:   parseInt(g.scans)   || 0,
          revenue: parseFloat(g.revenue) || 0,
        }))
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // POST — créer un fitness
  if (req.method === "POST") {
    const { name, address, filiale, email, password } = req.body || {};
    if (!name || !filiale || !email || !password)
      return res.status(400).json({ error: "Champs manquants." });
    try {
      const hash = await bcrypt.hash(password, 10);
      const [g] = await sql`
        INSERT INTO gyms (name, address, filiale, email, password)
        VALUES (${name}, ${address||null}, ${filiale}, ${email.toLowerCase()}, ${hash})
        RETURNING id, name, filiale, email
      `;
      return res.status(201).json({ ok: true, gym: g });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // PUT — modifier un fitness
  if (req.method === "PUT") {
    const { id, name, filiale, email, password } = req.body || {};
    if (!id) return res.status(400).json({ error: "id requis." });
    try {
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        await sql`UPDATE gyms SET name=${name}, filiale=${filiale}, email=${email.toLowerCase()}, password=${hash} WHERE id=${id}`;
      } else {
        await sql`UPDATE gyms SET name=${name}, filiale=${filiale}, email=${email.toLowerCase()} WHERE id=${id}`;
      }
      return res.json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).end();
};
