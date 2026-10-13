-- Fréquentation du site public (volt-energy.ch), sans cookie ni adresse IP : une ligne par page vue.
-- Lieu = en-têtes de géolocalisation de Vercel (pays, région, ville) ; provenance = domaine du site précédent ou utm_source.
-- new_visit : la page a été ouverte depuis l'extérieur du site (première page d'une visite). Purge à 400 jours (cron nightly).
create table if not exists site_views (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  path text not null,
  referrer text,
  source text,
  country text,
  region text,
  city text,
  device text check (device in ('mobile','tablet','desktop')),
  lang text,
  new_visit boolean not null default false
);
create index if not exists site_views_at on site_views (at desc);
