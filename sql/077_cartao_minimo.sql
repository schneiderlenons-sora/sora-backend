-- =====================================================================
-- 077 — Pagamento mínimo da fatura (informado pelo banco)
--
-- O painel mostrava "Pagamento mínimo" calculando 15% da fatura — um número
-- INVENTADO (dava R$211,57 enquanto o Mercado Pago informa R$31,32). O Open
-- Finance manda o valor real em credit_data.minimumPayment; guardamos aqui.
--
-- NULL = o banco não informou. Nesse caso a UI NÃO mostra o campo, em vez de
-- estimar — número errado com cara de oficial é pior que campo ausente.
-- Idempotente. Aplicar: Supabase → SQL Editor → Run.
-- =====================================================================

alter table public.wallets
  add column if not exists pagamento_minimo numeric;

comment on column public.wallets.pagamento_minimo is
  'Pagamento mínimo da fatura informado pelo banco via Open Finance (credit_data.minimumPayment). NULL = desconhecido; a UI não deve estimar.';

-- =====================================================================
-- Verificação:
--   select nome, saldo, limite, pagamento_minimo
--     from public.wallets where tipo = 'Crédito';
-- =====================================================================
