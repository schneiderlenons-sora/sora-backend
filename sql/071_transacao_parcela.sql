-- =====================================================================
-- 071 — Compra parcelada (cartão de crédito)
-- Cada parcela é uma transação (uma por mês). Estas colunas vinculam/rotulam:
--   parcela_num   → número da parcela (1..N)
--   parcela_total → total de parcelas (N) — mostra "3/4" na tabela e no cartão
--   parcela_grupo → id que agrupa as parcelas da MESMA compra (excluir/editar todas)
-- Idempotente.
-- =====================================================================

alter table public.transacoes add column if not exists parcela_num   smallint;
alter table public.transacoes add column if not exists parcela_total smallint;
alter table public.transacoes add column if not exists parcela_grupo text;

create index if not exists idx_transacoes_parcela_grupo
  on public.transacoes(parcela_grupo) where parcela_grupo is not null;
