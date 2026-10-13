-- Incidents remontés par les tablettes avec le heartbeat (plantage, relais muet, stockage, redémarrage…).
-- client_id : identifiant généré par la tablette, un heartbeat renvoyé ne crée pas de doublon. Purge à 30 jours (cron nightly).
create table if not exists station_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid unique,
  station_id uuid not null references stations on delete cascade,
  at timestamptz not null,
  level text not null check (level in ('info','warn','error')),
  kind text not null,
  message text,
  app_version text,
  created_at timestamptz default now()
);
create index if not exists station_events_station_at on station_events (station_id, at desc);
