-- =============================================================================
-- 200 — "Compra feita no dia do fechamento vai para a PRÓXIMA fatura"
--
-- Sugestão de cliente (Arisson, nov/2026, cartão Itaú cadastrado à mão): no
-- banco dele a compra feita no dia do fechamento entra na fatura seguinte, e a
-- Sora a colocava na fatura que fecha.
--
-- ⚠️ É UMA OPÇÃO POR CARTÃO, DESLIGADA POR PADRÃO — e isso foi medido:
--   · nas faturas publicadas pelos bancos, a compra do dia do fechamento vai
--     pra próxima em 76% dos casos (Nubank, C6, Mercado Pago, boa parte do
--     Itaú), mas FICA na que fecha na Caixa, BB, Inter e alguns Itaú;
--   · trocar a regra pra todos os cartões manuais fazia 11 faturas JÁ PAGAS
--     (pago = total, ao centavo) aparecerem como atrasadas.
-- Cartão do Open Finance ignora a opção (services/cicloFatura.js: lá a data do
-- lançamento no banco já decide a fatura).
--
-- Só ACRESCENTA uma coluna com default false: nenhum cartão muda de
-- comportamento ao rodar. Rodar de novo é seguro.
-- =============================================================================

alter table public.wallets
  add column if not exists fechamento_dia_proxima boolean not null default false;

comment on column public.wallets.fechamento_dia_proxima is
  'Cartão manual: compra feita NO DIA do fechamento entra na PRÓXIMA fatura (migration 200). Ignorado em cartão do Open Finance.';
