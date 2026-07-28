-- =====================================================================
-- 099 — Dedup do "previsto" da recorrência de valor variável, por mês
--
-- POR QUÊ: contas de valor variável (luz, vendas…) viram um lançamento
-- [Previsto] pendente no dia do vencimento, e a Sora pede o valor real. O
-- dedup antigo procurava a transação "[Previsto] X" do mês — mas quando o
-- usuário CONFIRMA, o handler remove o prefixo [Previsto] (vira "X"), o dedup
-- deixava de achar e o cron RECRIAVA o previsto + REAVISAVA na hora seguinte
-- (usuário recebia 21h e 22h a mesma coisa).
--
-- Fix: marca o mês do último previsto NA PRÓPRIA recorrência. Imune ao
-- confirmar/editar/excluir da transação.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.recorrencias
  add column if not exists ultimo_previsto_ym text;
