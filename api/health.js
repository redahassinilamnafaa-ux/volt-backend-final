const cors = require("../lib/cors");
module.exports = function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  res.status(200).json({ ok: true, volt: "API v1.0" });
};
