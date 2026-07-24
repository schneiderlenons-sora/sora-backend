-- =====================================================================
-- 094 — Cheque especial (limite de saldo negativo) por conta bancária
--
-- Um cliente reportou que ao transferir usando o limite do cheque especial o
-- sistema dava "saldo insuficiente" — não havia como a conta ficar negativa.
--
-- Gastos/pagamentos de fatura JÁ deixavam o saldo ir negativo (debitarConta não
-- valida). Só a TRANSFERÊNCIA travava em saldo < valor. Agora cada conta tem um
-- `cheque_especial` (teto de negativo): a transferência passa a permitir ir até
-- -cheque_especial. Default 0 = comportamento antigo (não deixa negativar).
--
-- Aplicar: Supabase → SQL Editor → Run. Idempotente.
-- =====================================================================

alter table public.wallets
  add column if not exists cheque_especial numeric(12,2) not null default 0;

-- Nunca negativo no PRÓPRIO limite (é um teto em módulo; guardamos positivo).
alter table public.wallets
  drop constraint if exists wallets_cheque_especial_nonneg;
alter table public.wallets
  add constraint wallets_cheque_especial_nonneg check (cheque_especial >= 0);
