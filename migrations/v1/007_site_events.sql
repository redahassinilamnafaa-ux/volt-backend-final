-- Actions sur le site public, sans cookie ni identifiant de visiteur : formulaire de contact, quiz terminé,
-- clic téléphone / email / WhatsApp, lien sortant, lecture (profondeur lue + temps passé).
-- from_path = page précédente sur le site ; source = site d'arrivée ou utm_source si l'action a lieu sur la page d'arrivée.
create table if not exists site_events (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  kind text not null check (kind in ('contact','quiz','tel','mail','whatsapp','sortie','lecture')),
  label text,
  path text not null,
  from_path text,
  source text,
  depth smallint,
  seconds integer
);
create index if not exists site_events_at on site_events (at desc);
