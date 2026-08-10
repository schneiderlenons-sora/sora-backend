-- =====================================================================
-- 114 — A data de fechamento/vencimento que o USUÁRIO corrigiu não pode ser
--       sobrescrita pelo sync do Open Finance.
--
-- BUG QUE ISTO CORRIGE: o painel deixa editar o dia de fechamento e o de
-- vencimento do cartão, mas o sync do Open Finance regrava esses campos toda
-- vez que roda (1×/dia). Resultado: o usuário conserta a data, e no dia
-- seguinte ela volta pro valor do banco — sem aviso nenhum.
--
-- Isso só virou problema porque o banco às vezes ESTÁ ERRADO. Caso real
-- (Mercado Pago, cartão final 4430): as 9 faturas que a API publica dizem
-- todas "fecha dia 12, vence dia 17", e o app do MP mostra fecha 8 / vence 14.
-- O MP mudou o ciclo e ainda não publicou nenhuma fatura no ciclo novo, então
-- a API não tem como saber — e nenhuma regra nossa consegue adivinhar.
--
-- A saída é dar a palavra final ao usuário: quem edita a data à mão marca o
-- cartão como `datas_manuais`, e o sync passa a respeitar. Os demais campos
-- (saldo, fatura, limite) continuam vindo do banco normalmente — só as DATAS
-- ficam congeladas.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.wallets
  add column if not exists datas_manuais boolean not null default false;

comment on column public.wallets.datas_manuais is
  'true = o usuário corrigiu dia_fechamento/dia_vencimento à mão; o sync do Open Finance NÃO regrava esses dois campos. Ver sql/114.';

-- Conferência:
--   select nome, dia_fechamento, dia_vencimento, datas_manuais
--     from wallets where tipo = 'Crédito';
