const cors            = require("../lib/cors");
const sql             = require("../lib/db");
const { requireAuth } = require("../lib/auth");
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const auth = requireAuth(req);
  if (!auth) return res.status(401).json({ error: "Non authentifié." });
  try {
    const rows = await sql`
      SELECT s.scanned_at, g.name AS gym_name
      FROM scans s LEFT JOIN gyms g ON s.gym_id = g.id
      WHERE s.user_id = ${auth.id}
      ORDER BY s.scanned_at DESC LIMIT 50
    `;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const history = rows.map(s => {
      const d = new Date(s.scanned_at);
      const isToday = d >= todayStart;
      const isYest  = d >= new Date(todayStart - 86400000) && !isToday;
      const hm = d.toLocaleTimeString("fr-CH", { hour: "2-digit", minute: "2-digit" });
      const timeStr = isToday ? `Auj. ${hm}` : isYest ? `Hier ${hm}`
        : `${d.toLocaleDateString("fr-CH", { day: "numeric", month: "short" })} ${hm}`;
      return { gym: s.gym_name || "Fitness VOLT", time: timeStr, today: isToday };
    });
    return res.json({ history });
  } catch (e) {
    return res.status(500).json({ error: "Erreur serveur." });
  }
};
