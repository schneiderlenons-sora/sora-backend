-- =====================================================================
-- 011 — Lembretes de dividas (controle por divida e por usuario)
-- Idempotente.
-- =====================================================================

-- Por divida: pode silenciar uma divida especifica
alter table public.dividas
  add column if not exists lembretes_ativos boolean not null default true;

-- Marca quando o ultimo lembrete foi enviado (evita duplicar no mesmo dia)
alter table public.dividas
  add column if not exists ultimo_lembrete_em date;

-- Por usuario: cancela TODOS os lembretes de dividas de uma vez
alter table public.users
  add column if not exists lembretes_dividas boolean not null default true;

create index if not exists idx_dividas_lembrete
  on public.dividas(grupo_id, dia_vencimento)
  where status = 'ativa' and lembretes_ativos = true;
