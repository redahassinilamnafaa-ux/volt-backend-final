-- VOLT. v1 — schéma initial (base Neon « volt_v1 »).
-- Repris de handoff_volt/02_backend/schema.sql, complété pour l'API v1
-- (pause, tablette, jetons de réinitialisation, OTP contrat, journal admin, cron).
-- Appliqué par POST /api/v1/setup (voir README-v1.md). Une instruction par bloc « ; ».

create table if not exists gyms (
  id uuid primary key default gen_random_uuid(),
  name text not null, legal_name text, ide text, address text, city text, filiale text,
  contact_name text, contact_email text, contact_phone text,
  contract_status text not null default 'prospect' check (contract_status in ('prospect','en_cours','signe')),
  created_at timestamptz default now()
);

create table if not exists gym_users (
  id uuid primary key default gen_random_uuid(), gym_id uuid references gyms on delete cascade,
  role text not null check (role in ('gym','admin')), email text unique not null, password_hash text not null,
  name text, created_at timestamptz default now(),
  check (role = 'admin' or gym_id is not null)
);

create table if not exists stations (
  id uuid primary key default gen_random_uuid(), gym_id uuid not null references gyms on delete cascade,
  name text not null, location text, installed_on date, tablet_token_hash text unique,
  last_heartbeat timestamptz, relay_ok boolean, app_version text, serve_signal boolean default false,
  battery int, queue_len int,
  next_maintenance_on date, next_maintenance_slot text,
  created_at timestamptz default now()
);

create table if not exists members (
  id uuid primary key default gen_random_uuid(), gym_id uuid not null references gyms on delete cascade,
  prenom text not null, nom text not null, telephone text not null, email text not null,
  naissance date, ref_salle text, code_acces text not null,
  debut date not null, fin date not null, duree text, -- '1m','12m','Nm' ou null si date libre
  statut text not null default 'actif' check (statut in ('actif','pause','bloque')),
  reprise date, prolonger boolean default false, motif text, notes text,
  pause_debut date, pause_ext_applied boolean default false,
  welcome_sent_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(),
  unique (gym_id, code_acces),
  check (fin >= debut)
);

create table if not exists passages (
  id uuid primary key default gen_random_uuid(), client_id uuid unique,
  gym_id uuid not null references gyms on delete cascade, station_id uuid references stations on delete set null,
  member_id uuid references members on delete set null, code text not null,
  ts timestamptz not null, result text not null check (result in ('ok','delai','inconnu','pause','bloque','expire','avenir','relais')),
  offline boolean default false
);
create index if not exists passages_gym_ts on passages (gym_id, ts desc);
create index if not exists passages_member_ts on passages (member_id, ts desc);

create table if not exists passages_monthly (
  gym_id uuid references gyms on delete cascade, month date not null,
  ok_count int not null default 0, refused_count int not null default 0, distinct_members int not null default 0,
  primary key (gym_id, month)
);

create table if not exists autocontrols (
  id uuid primary key default gen_random_uuid(), gym_id uuid not null references gyms on delete cascade,
  station_id uuid references stations on delete set null, day date not null, checks jsonb not null, weekly boolean default false,
  visa text not null, note text, late boolean default false, created_at timestamptz default now()
);
create unique index if not exists autocontrols_gym_station_day on autocontrols (gym_id, coalesce(station_id, '00000000-0000-0000-0000-000000000000'::uuid), day);

create table if not exists anomalies (
  id uuid primary key default gen_random_uuid(), autocontrol_id uuid references autocontrols on delete cascade,
  type text not null, description text not null, saveur text, lot text,
  station_off boolean default false, pouch_kept boolean default false, photo_url text, created_at timestamptz default now()
);

create table if not exists deliveries (
  id uuid primary key default gen_random_uuid(), gym_id uuid not null references gyms on delete cascade,
  delivered_on date not null, stock_days int not null check (stock_days > 0), note text, created_at timestamptz default now()
);

create table if not exists delivery_items (
  delivery_id uuid references deliveries on delete cascade, product text not null, qty int not null check (qty > 0)
);

create table if not exists maintenances (
  id uuid primary key default gen_random_uuid(), station_id uuid not null references stations on delete cascade,
  done_on date not null, type text not null check (type in ('Semestriel','Intervention','Installation')),
  technician text, note text, created_at timestamptz default now()
);

create table if not exists contract_versions (
  version text primary key, text text not null, sha256 text not null,
  is_current boolean not null default false, created_at timestamptz default now()
);

create table if not exists contract_signatures (
  id uuid primary key default gen_random_uuid(), gym_id uuid not null references gyms on delete cascade,
  version text not null, signer_name text not null, signer_role text not null,
  signed_at timestamptz not null default now(), ip inet, user_agent text, text_sha256 text not null, pdf_url text
);

create table if not exists contract_otps (
  gym_id uuid primary key references gyms on delete cascade, user_id uuid references gym_users on delete cascade,
  code_hash text not null, signer_name text not null, signer_role text not null, version text not null,
  attempts int not null default 0, expires_at timestamptz not null
);

create table if not exists password_resets (
  token_hash text primary key, user_id uuid not null references gym_users on delete cascade,
  expires_at timestamptz not null, used_at timestamptz
);

create table if not exists emails_log (
  id uuid primary key default gen_random_uuid(), kind text not null, to_email text not null,
  gym_id uuid, member_id uuid, provider_id text, error text, sent_at timestamptz default now()
);

create table if not exists admin_audit (
  id bigserial primary key, user_id uuid, method text not null, path text not null, at timestamptz default now()
);

create table if not exists rate_hits (
  key text not null, at timestamptz not null default now()
);
create index if not exists rate_hits_key_at on rate_hits (key, at);

create table if not exists cron_runs (
  job text not null, run_key text not null, at timestamptz default now(), primary key (job, run_key)
);
