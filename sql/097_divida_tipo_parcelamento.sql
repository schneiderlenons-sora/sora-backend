-- =====================================================================
-- 097 — Permite o tipo 'parcelamento' em dividas
--
-- A "compra parcelada SEM cartão" cria uma dívida com tipo='parcelamento'
-- (ver project-parcelamento-sem-cartao), mas o CHECK antigo (sql/010) só
-- aceitava emprestimo/financiamento/crediario/cartao_rotativo/cheque_especial/
-- consignado/fies/outro → dava "violates check constraint dividas_tipo_check".
--
-- Lição recorrente: tipo/enum novo precisa entrar no CHECK via migration
-- (ver project-plano-check-constraint). Idempotente.
-- Aplicar: Supabase → SQL Editor → Run.
-- =====================================================================

alter table public.dividas drop constraint if exists dividas_tipo_check;

alter table public.dividas add constraint dividas_tipo_check
  check (tipo in (
    'emprestimo','financiamento','crediario','cartao_rotativo',
    'cheque_especial','consignado','fies','parcelamento','outro'
  ));
