-- =====================================================================
-- 101 — Vincular a transação do cartão à FATURA do emissor (Open Finance)
--
-- Por que: agrupar as compras do cartão pelo CICLO (data ≥ ini e < fim) está
-- certo pra cartão manual, mas erra no Open Finance em dois casos reais,
-- medidos na conta de um usuário (Mercado Pago, jul/2026):
--
--   1. PARCELAMENTO. A Celcoin manda cada parcela como uma transação, mas
--      TODAS com a data da COMPRA. Uma compra de 20/06 em 3× virou três
--      lançamentos em 20/06 → as 3 parcelas caíram na fatura de junho, quando
--      no cartão real elas caem em julho, agosto e setembro. A fatura de junho
--      inflou R$ 113,33 e a de agosto ficou R$ 56,66 a menos.
--   2. ENCARGOS na virada. Juros/multa/IOF do rotativo lançados no primeiro dia
--      do ciclo novo pertencem, no extrato do banco, à fatura ANTERIOR.
--
-- Nenhum dos dois se resolve com aritmética de data: quem sabe em qual fatura a
-- linha entra é o EMISSOR. A Celcoin diz isso no `bill_id` de cada transação
-- (docs/CELCOIN-API.md §5.2) — é medido, não projetado. Guardamos esse vínculo
-- e o usamos pra somar a fatura; sem ele, tudo continua caindo no ciclo.
--
-- `wallets.of_bill_atual` = bill_id da fatura EM ABERTO, pra tela saber qual
-- das faturas o `of_bill_id` das transações representa hoje.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.transacoes add column if not exists of_bill_id text;
alter table public.wallets   add column if not exists of_bill_atual text;

-- Somar uma fatura = varrer as transações daquele bill_id.
create index if not exists idx_transacoes_of_bill
  on public.transacoes(of_bill_id) where of_bill_id is not null;
