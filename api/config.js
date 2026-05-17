const cors = require("../lib/cors");

module.exports = function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  res.json({
    stripe_key: process.env.STRIPE_PUBLISHABLE_KEY || ""
  });
};
