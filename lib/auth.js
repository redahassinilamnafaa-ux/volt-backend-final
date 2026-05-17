const jwt = require("jsonwebtoken");
const SECRET = process.env.JWT_SECRET || "volt-dev-secret";
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
