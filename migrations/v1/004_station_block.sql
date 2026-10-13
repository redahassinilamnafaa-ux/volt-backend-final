-- Blocage d'une station par VOLT. (ex. litige, panne, sécurité) : la tablette refuse tous les passages tant que blocked = true.
alter table stations add column if not exists blocked boolean not null default false;
alter table stations add column if not exists blocked_reason text;
alter table stations add column if not exists blocked_at timestamptz;
