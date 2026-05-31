const jwt = require("jsonwebtoken");
if (!process.env.JWT_SECRET) console.error("[auth] JWT_SECRET manquant — définir dans les variables d'environnement Vercel");
const SECRET = process.env.JWT_SECRET || "volt-jwt-fallback-set-JWT_SECRET-in-vercel";
module.exports = {
  signToken(payload) {
    return jwt.sign(payload, SECRET, { expiresIn: "90d" });
  },
  requireAuth(req) {
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return null;
    try { return jwt.verify(h.slice(7), SECRET); }
    catch (e) { return null; }
  }
};
