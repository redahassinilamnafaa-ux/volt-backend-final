const cors = require("../lib/cors");
const sql  = require("../lib/db");
const CD   = 15 * 60;
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();
  if (req.headers["x-machine-secret"] !== process.env.MACHINE_SECRET)
    return res.status(401).json({ result: "DENIED", reason: "SECRET_INVALID" });
  const { user_id, machine_id, gym_id } = req.body || {};
  if (!user_id) return res.status(400).json({ result: "DENIED", reason: "NO_USER_ID" });
  try {
    const [u] = await sql`SELECT * FROM users WHERE id = ${user_id}`;
    if (!u)            return res.json({ result: "DENIED", reason: "USER_NOT_FOUND" });
    if (!u.subscribed) return res.json({ result: "DENIED", reason: "NOT_SUBSCRIBED" });
    if (!u.authorized) return res.json({ result: "DENIED", reason: "BLOCKED_BY_GYM" });
    if (u.sub_expires_at && new Date(u.sub_expires_at) < new Date())
      return res.json({ result: "DENIED", reason: "SUB_EXPIRED" });
    const now = new Date();
    const [cd] = await sql`SELECT expires_at FROM cooldowns WHERE user_id = ${u.id}`;
    if (cd && new Date(cd.expires_at) > now)
      return res.json({ result: "COOLDOWN", remaining_secs: Math.ceil((new Date(cd.expires_at) - now) / 1000) });
    const exp = new Date(now.getTime() + CD * 1000);
    await sql`INSERT INTO scans (user_id, gym_id, machine_id) VALUES (${u.id}, ${gym_id || null}, ${machine_id || null})`;
    await sql`INSERT INTO cooldowns (user_id, expires_at) VALUES (${u.id}, ${exp}) ON CONFLICT (user_id) DO UPDATE SET expires_at = ${exp}`;
    return res.json({ result: "APPROVED", user_name: `${u.first_name} ${u.last_name}`, plan: u.plan });
  } catch (e) {
    return res.status(500).json({ result: "DENIED", reason: "SERVER_ERROR" });
  }
};
