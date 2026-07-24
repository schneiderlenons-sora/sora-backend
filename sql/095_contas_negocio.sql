-- =====================================================================
-- 095 — Contas do negócio (caixas nomeadas) por empresa
--
-- Um cliente de loja física relatou que não dava pra dizer EM QUAL conta o
-- dinheiro entra/sai (dinheiro, banco digital, maquininha) nem ver o saldo de
-- cada uma — o lançamento só tinha `forma_pagamento` (uma tag).
--
-- Agora cada empresa tem suas CONTAS (o dono cria/nomeia) e cada lançamento
-- do caixa pode apontar pra uma conta. Saldo por conta =
--   saldo_inicial + entradas pagas − saídas pagas  (só status='pago').
--
-- Escopo por empresa_id + user_id (padrão das outras tabelas de Negócios 2.0).
-- Aplicar: Supabase → SQL Editor → Run. Idempotente.
-- =====================================================================

create table if not exists public.contas_negocio (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  user_id       uuid not null references public.users(id)    on delete cascade,
  nome          text not null,
  -- Tipo só pra ícone/agrupamento; texto livre com CHECK tolerante.
  tipo          text not null default 'dinheiro'
                  check (tipo in ('dinheiro','banco','cartao','outro')),
  saldo_inicial bigint not null default 0,   -- centavos (abertura da conta)
  cor           text,
  ativa         boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists idx_contas_negocio_empresa
  on public.contas_negocio(empresa_id) where ativa;

-- Vínculo do lançamento com a conta (nullable — lançamentos antigos ficam
-- "sem conta"; on delete set null pra não perder o histórico se a conta sumir).
alter table public.lancamentos_negocio
  add column if not exists conta_id uuid
  references public.contas_negocio(id) on delete set null;

create index if not exists idx_lanc_conta
  on public.lancamentos_negocio(conta_id) where conta_id is not null;
