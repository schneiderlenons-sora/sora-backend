-- =====================================================================
-- 029 — FITID nas transações (dedup de importação OFX)
-- Cada transação no OFX tem um <FITID> único por conta. Guardamos ele pra
-- NÃO reimportar a mesma transação (ex.: reimportar o mesmo extrato, ou o
-- extrato trazer uma transação que já foi lançada antes).
-- Idempotente. Aplicar: Supabase Dashboard -> SQL Editor -> Run.
-- =====================================================================

alter table public.transacoes
  add column if not exists fitid text;

-- Busca rápida de duplicatas por grupo + fitid
create index if not exists transacoes_grupo_fitid_idx
  on public.transacoes (grupo_id, fitid)
  where fitid is not null;
