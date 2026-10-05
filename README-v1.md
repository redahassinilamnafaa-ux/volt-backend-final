# API v1 — VOLT. (stations en salles partenaires)

Implémente `handoff_volt/02_backend/API.md`. Base : `https://<backend>/api/v1`. L'ancienne API (`/api/*.js`, app membre) reste en place tant qu'elle n'est pas débranchée.

## Architecture
- `api/v1.js` : point d'entrée unique (réécriture `/api/v1/:path*` dans `vercel.json`).
- `lib/v1/routes/{auth,gym,admin,tablet,cron}.js` : routes. `lib/v1/rules.js` : règles métier pures (statut, fin d'abonnement, 15 min, fuseau Zurich).
- `migrations/v1/*.sql` : schéma (base Neon dédiée `volt_v1`, variable `DATABASE_URL_V1`).
- Emails : Resend, expéditeur `no-reply@volt-energy.ch`, tous tracés dans `emails_log`.

## Variables d'environnement (Vercel)
Aucune nouvelle variable obligatoire.

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Déjà présente : la base `volt_v1` est créée et utilisée sur le même serveur Neon |
| `DATABASE_URL_V1` | Facultatif : autre base pour la v1 |
| `JWT_SECRET` / `RESEND_API_KEY` | Déjà présents |
| `ADMIN_EMAIL` | Facultatif : compte admin (défaut `VOLT_EMAIL`) |
| `VOLT_EMAIL` | Alertes VOLT. (défaut `info@volt-energy.ch`) |
| `APP_URL` | Liens des emails (défaut `https://www.volt-energy.ch`) |
| `CRON_SECRET` | Facultatif : si défini, exigé sur `/cron/tick` ; toujours exigé pour `?job=` |

## Installation (une fois)
```bash
curl -X POST https://<backend>/api/v1/setup
```
Crée la base `volt_v1`, applique les migrations (idempotent) et, tant que le compte admin n'est pas activé, envoie à `ADMIN_EMAIL` un lien pour choisir le mot de passe (valable 24 h). Puis publier le contrat : `POST /admin/contract-versions {version:"2.0", text:"<html exact affiché>"}` (l'empreinte SHA-256 est calculée sur ce texte).

## Authentification
- Gérant / admin : `POST /auth/login` → `{token}` + cookie httpOnly `volt_session` (SameSite=Lax). Le front envoie `Authorization: Bearer <token>` ; le cookie fonctionne si `/api/v1` est servi sur le même domaine que le site (réécriture Vercel conseillée).
- Tablette : `Authorization: Bearer vt_…`, jeton créé par `POST /admin/stations/:id/token` (renvoyé une seule fois, champ `provisioning` à mettre dans le QR).

## Écarts / précisions par rapport à API.md
- Fin d'abonnement : 31.01 + 1 mois → 28/29.02 (règle de la spec ; la maquette donnait 02.03, à aligner côté front).
- `/tablet/sync` renvoie tous les membres non expirés (avec `debut`, `fin`, `statut`, `reprise`, `status`) pour que la tablette recalcule le statut hors ligne ; `passages/batch` renvoie `rejected` (client_id invalides, à retirer de la file).
- Photo d'anomalie : jointe à l'email VOLT. (data URL ≤ 3 Mo), pas stockée.
- PDF du contrat : régénéré à la demande (`GET /gym/contract/pdf`), envoyé à la signature au contact de la salle, au gérant et à VOLT.
- Crons : un seul cron horaire `/api/v1/cron/tick` qui lance chaque tâche à son heure de Zurich (03:00 purge/agrégats, 07:00 le 1er rapport mensuel, 08:00 emails salles + récap admin). Lancement manuel : `?job=nightly|monthly|gym_daily|admin_recap`.
- Routes en plus : `POST /auth/logout`, `GET /gym/contract`, `GET /gym/contract/pdf`, `POST /admin/gyms/:id/user`, `GET/POST /admin/contract-versions`.

## Tests
`npm test` : règles métier + parcours complet de l'API sur un Postgres en mémoire (PGlite).
