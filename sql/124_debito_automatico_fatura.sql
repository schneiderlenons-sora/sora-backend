-- =============================================================================
-- 124 — "Débito automático FATURA ..." é pagamento de fatura, não gasto
--
-- RELATO: cliente comparou o painel com o app do Itaú e os números não batiam.
-- Ao conferir os gastos de agosto, os DOIS maiores eram:
--     R$ 13.123,09  "Débito automático FATURA ITAU PERSON MC BLACK"
--     R$  2.753,80  "Débito automático FATURA ITAU UNICLASS VS SIG"
--
-- CAUSA: `ehPagamentoFaturaDescricao` exigia uma palavra de PAGAMENTO
-- ("pagamento|pagto|pgto|pag") antes de "fatura". O Itaú escreve
-- "DÉBITO AUTOMÁTICO", que não estava na lista — então a quitação entrava como
-- gasto comum.
--
-- POR QUE IMPORTA: a fatura é paga UMA vez mas aparece nos DOIS lados (sai da
-- conta, abate no cartão). Contar o pagamento como gasto conta EM DOBRO, já que
-- cada compra da fatura já foi categorizada uma a uma. Medido neste cliente:
-- 5 linhas, R$ 30.896,16 inflando os gastos dele.
--
-- O código já foi corrigido (services/categorizar.js), mas o sync NUNCA
-- reescreve linha existente — de propósito, senão apagaria a categoria que o
-- usuário corrigiu à mão. Esta migration conserta o histórico.
--
-- ⚠️ ESCOPO ESTREITO: exige "debito automatico" E "fatura"/"cart" na mesma
-- descrição. Débito automático de plano de saúde e seguro (medido: 21 das 26
-- linhas com "débito automático" na base) NÃO é tocado — some do relatório
-- gasto que o cliente teve de verdade seria pior que o bug original.
--
-- Idempotente. Rodar no Supabase → SQL Editor.
-- =============================================================================

update public.transacoes
set
  transferencia = true,
  categoria     = '💳 Fatura'
where
  tipo = 'Gasto'
  and coalesce(transferencia, false) = false
  -- `unaccent` não está garantido em toda instalação; a comparação usa ILIKE
  -- com as duas grafias (com e sem acento) pra não depender da extensão.
  and (observacao ILIKE '%debito autom%' OR observacao ILIKE '%débito autom%')
  and (observacao ILIKE '%fatura%' OR observacao ILIKE '%cartao%' OR observacao ILIKE '%cartão%');

-- =============================================================================
-- Conferência ANTES de rodar (troque update por select pra ver o que muda):
--   select id, data, valor, observacao, carteira_nome
--     from public.transacoes
--    where tipo = 'Gasto' and coalesce(transferencia,false) = false
--      and (observacao ILIKE '%debito autom%' OR observacao ILIKE '%débito autom%')
--      and (observacao ILIKE '%fatura%' OR observacao ILIKE '%cartao%' OR observacao ILIKE '%cartão%');
--
-- Verificação DEPOIS (deve voltar 0 linhas):
--   …o mesmo select acima.
-- =============================================================================
