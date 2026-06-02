const jwt = require("jsonwebtoken");
if (!process.env.JWT_SECRET) {
  console.error("[auth] FATAL: JWT_SECRET manquant — définir dans les variables d'environnement Vercel");
  // Ne pas lancer une exception ici pour éviter de casser le cold-start Vercel,
  // mais toute opération de signature/vérification échouera proprement ci-dessous.
}
const SECRET = process.env.JWT_SECRET;
module.exports = {
  signToken(payload, expiresIn = "30d") {
    if (!SECRET) throw new Error("JWT_SECRET non configuré.");
    return jwt.sign(payload, SECRET, { expiresIn });
  },
  requireAuth(req) {
    if (!SECRET) return null;
    const h = req.headers.authorization || "";
    if (!h.startsWith("Bearer ")) return null;
    try { return jwt.verify(h.slice(7), SECRET); }
    catch (e) { return null; }
  }
};
