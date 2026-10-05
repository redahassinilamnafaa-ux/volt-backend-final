-- Champs utilisés par le back-office (04_admin) : suspension et date de signature manuelle d'une salle,
-- statut « résilié », adresse du relais d'une station, technicien et note de l'entretien planifié,
-- types d'entretien de la maquette (Contrôle, Réparation).
alter table gyms add column if not exists suspended boolean not null default false;
alter table gyms add column if not exists signed_on date;
alter table gyms drop constraint if exists gyms_contract_status_check;
alter table gyms add constraint gyms_contract_status_check check (contract_status in ('prospect','en_cours','signe','resilie'));
alter table stations add column if not exists relay_host text;
alter table stations add column if not exists next_maintenance_tech text;
alter table stations add column if not exists next_maintenance_note text;
alter table maintenances drop constraint if exists maintenances_type_check;
alter table maintenances add constraint maintenances_type_check check (type in ('Semestriel','Intervention','Installation','Contrôle','Réparation'));
