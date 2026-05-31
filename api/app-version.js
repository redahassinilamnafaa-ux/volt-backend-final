// GET /api/app-version — CM30 remote update check
// Update version_code + apk_url here each time you release a new APK.

const MACHINE_SECRET = process.env.MACHINE_SECRET || "volt-admin-secret-2025";

const LATEST = {
  version_code: 3,
  version_name: "1.2.0",
  apk_url: "",          // e.g. "https://cdn.example.com/volt-terminal-1.2.0.apk"
  release_notes: "Version initiale"
};

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Méthode non autorisée." });
  }
  const secret = req.headers["x-machine-secret"];
  if (secret !== MACHINE_SECRET) {
    return res.status(401).json({ error: "Non autorisé." });
  }
  return res.status(200).json(LATEST);
};
