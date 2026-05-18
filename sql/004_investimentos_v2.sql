-- =====================================================================
-- 004 — Campos extras para investimentos + tabela reserva de emergência
-- Idempotente.
-- =====================================================================

alter table public.investimentos
  add column if not exists variacao_dia            numeric(10,4) default 0,
  add column if not exists variacao_mes            numeric(10,4) default 0,
  add column if not exists variacao_ano            numeric(10,4) default 0,
  add column if not exists moeda                   varchar(3)    default 'BRL',
  add column if not exists setor                   varchar(100),
  add column if not exists nome_completo           varchar(200),
  add column if not exists taxa_anual              numeric(8,4),
  add column if not exists data_vencimento         date,
  add column if not exists indexador               varchar(20),
  add column if not exists percentual_indexador    numeric(8,4),
  add column if not exists is_reserva_emergencia   boolean default false,
  add column if not exists dividendos_acumulados   numeric(12,2) default 0,
  add column if not exists rentabilidade           numeric(10,4) default 0,
  add column if not exists ultima_atualizacao      timestamp;

create table if not exists public.reserva_emergencia_config (
  id                  uuid primary key default gen_random_uuid(),
  grupo_id            uuid not null references public.grupos(id) on delete cascade,
  meses_objetivo      int default 6,
  gasto_mensal_medio  numeric(12,2) default 0,
  valor_objetivo      numeric(12,2) default 0,
  created_at          timestamp default now(),
  updated_at          timestamp default now(),
  unique (grupo_id)
);

create index if not exists idx_reserva_grupo on public.reserva_emergencia_config(grupo_id);
