-- 203 — Notas no painel (aba Notas do Drive).
--
-- Pedido de cliente (nov/2026): "Poderia ter um espaço para notas! Eu escrevo
-- muito!". A tabela `notas` já existia (063) pras notas do WhatsApp ("anota
-- que …"); o painel passa a listar, criar, editar, fixar e apagar nela.
--
-- Sem esta migration: listar, criar, editar e apagar funcionam; só "fixar"
-- responde que ainda está sendo liberado. Rodar de novo é seguro.

alter table public.notas
  add column if not exists fixada boolean not null default false;

-- Sem default no ADD: assim as notas que já existem ficam com NULL e recebem a
-- data de criação logo abaixo (com default, todas virariam "editadas agora").
alter table public.notas
  add column if not exists updated_at timestamptz;

update public.notas set updated_at = created_at where updated_at is null;

alter table public.notas
  alter column updated_at set default now();

create index if not exists idx_notas_user_fixada
  on public.notas (user_id, fixada, updated_at desc);
