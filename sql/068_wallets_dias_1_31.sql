-- =====================================================================
-- 068 — Cartões: permite dia de FECHAMENTO/VENCIMENTO de 1 a 31
-- O 023 limitou ambos a 1..28, mas o dropdown do painel oferece até 31 →
-- criar cartão com dia 29/30/31 violava wallets_dia_fechamento_check /
-- wallets_dia_vencimento_check ("new row ... violates check constraint").
-- Relaxa pra 1..31 (igual à tabela dividas). Idempotente.
-- =====================================================================

alter table public.wallets drop constraint if exists wallets_dia_fechamento_check;
alter table public.wallets drop constraint if exists wallets_dia_vencimento_check;

alter table public.wallets
  add constraint wallets_dia_fechamento_check check (dia_fechamento between 1 and 31),
  add constraint wallets_dia_vencimento_check check (dia_vencimento between 1 and 31);

-- =====================================================================
-- Verificação:
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.wallets'::regclass
--      and conname in ('wallets_dia_fechamento_check','wallets_dia_vencimento_check');
-- =====================================================================
