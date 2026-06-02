const ALLOWED_ORIGINS = [
  "https://volt-energy.ch",
  "https://www.volt-energy.ch",
];

module.exports = function cors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || "";
  // Autoriser les origines connues + les previews Vercel
  const allowed =
    ALLOWED_ORIGINS.includes(origin) ||
    /^https:\/\/[a-zA-Z0-9-]+-reda[a-zA-Z0-9-]*\.vercel\.app$/.test(origin) ||
    /^https:\/\/volt[a-zA-Z0-9-]*\.vercel\.app$/.test(origin);
  res.setHeader("Access-Control-Allow-Origin", allowed ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,x-machine-secret");
};
