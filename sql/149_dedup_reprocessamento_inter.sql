-- =============================================================================
-- 149 — Remove as duplicatas criadas pelo REPROCESSAMENTO da Polp (Banco Inter)
--
-- A Polp reprocessou as transações de um cartão do Banco Inter e regravou TODAS
-- elas com `of_tx_id` NOVO. Como o sync dedupa por `of_tx_id` — de propósito, é
-- o que protege a categoria corrigida à mão —, as linhas antigas continuaram no
-- banco e passaram a conviver com as novas.
--
-- ⚠️ O CRITÉRIO NÃO É "mesma data e mesmo valor". Isso não distingue duplicata
-- de duas compras iguais, e o próprio cliente tem R$ 130,00 no PRIMOS BEER em
-- 06/08, 24/08 e 31/08 — todas legítimas. O critério é a ORIGEM: o
-- reprocessamento gravou um bloco contíguo de ids (`01a06251-…`, 10 linhas), e
-- as três linhas de FORA desse bloco têm gêmeo idêntico DENTRO dele.
--
-- Medido antes de escrever, nas 13 transações do cartão:
--   linhas no bloco do reprocessamento .......... 10
--   fora do bloco COM gêmeo dentro (duplicatas) .. 3   ← estas
--   fora do bloco SEM gêmeo ...................... 0   ← nada se perde
--
-- O "zero órfãos" é a prova: o reprocessamento é um superconjunto completo do
-- que havia antes. Nenhuma transação existe só na versão velha.
--
-- As três, somando R$ 949,73:
--   2026-07-10  Recebimento  R$ 639,73  "pagto debito automatico"
--   2026-08-27  Gasto        R$ 180,00  "GOL LINHAS A JIVRYG014"
--   2026-08-31  Gasto        R$ 130,00  "PRIMOS BEER MARINGA"
--
-- Efeito na fatura de setembro (ciclo 04/08 → 03/09):
--   gastos com duplicatas ... R$ 1.916,31
--   gastos sem duplicatas ... R$ 1.606,31
--   + parcela azul seguros .. R$   388,93
--   = fatura ................ R$ 1.995,24   ← exatamente o valor do banco
--
-- ⚠️ O sync NÃO recria estas linhas: ele insere pelos ids que a API devolve, e
-- a API não devolve mais os antigos.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =============================================================================

-- CONFIRA ANTES (deve devolver exatamente as 3 linhas descritas acima):
--
--   select data, tipo, valor, observacao, of_tx_id, created_at
--     from public.transacoes
--    where of_tx_id in (
--            '01a05c77-f673-7323-ab74-3c7d425ff47f',
--            '01a05d26-593b-71be-acc1-906f33bdc907',
--            '01a060b1-f0fc-71c8-b1be-2b48c7ecf5a2');

delete from public.transacoes
 where of_tx_id in (
         '01a05c77-f673-7323-ab74-3c7d425ff47f',   -- pagto debito automatico 10/07
         '01a05d26-593b-71be-acc1-906f33bdc907',   -- GOL LINHAS A 27/08
         '01a060b1-f0fc-71c8-b1be-2b48c7ecf5a2'    -- PRIMOS BEER 31/08
       );

-- CONFIRA DEPOIS (deve devolver 0 linhas):
--
--   select count(*) from public.transacoes
--    where of_tx_id in (
--            '01a05c77-f673-7323-ab74-3c7d425ff47f',
--            '01a05d26-593b-71be-acc1-906f33bdc907',
--            '01a060b1-f0fc-71c8-b1be-2b48c7ecf5a2');
