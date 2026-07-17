-- =====================================================================
-- 078 — Remove parcelas FUTURAS importadas como gasto (Open Finance)
--
-- A Polp devolve parcela a vencer como transação com data no FUTURO
-- (ex.: 2027-03-13, "DL *HOTEIS.COM 12/12", status PENDING). A Pluggy direta
-- não fazia isso, e o polpSync importava tudo — então entrou despesa de 2027
-- no painel. O sync já foi corrigido (só aceita data <= hoje); esta migration
-- limpa o que já entrou.
--
-- No teste fechado eram 19 linhas somando R$ 2.504,43, todas do cartão Nubank
-- — e esse valor é exatamente a diferença entre o `balance` do banco (5.349,63)
-- e a fatura real (2.845,20). Ou seja: são as parcelas a vencer.
--
-- Mexe SÓ em linha do Open Finance (of_tx_id is not null) e SÓ no futuro —
-- nunca em lançamento manual/WhatsApp. Idempotente.
-- Aplicar: Supabase → SQL Editor → Run.
-- =====================================================================

-- Confira ANTES o que vai sair (opcional):
--   select carteira_nome, data, valor, observacao
--     from public.transacoes
--    where of_tx_id is not null and data::date > current_date
--    order by data;

delete from public.transacoes
 where of_tx_id is not null
   and data::date > current_date;

-- =====================================================================
-- Verificação (tem que voltar 0):
--   select count(*) from public.transacoes
--    where of_tx_id is not null and data::date > current_date;
-- =====================================================================
