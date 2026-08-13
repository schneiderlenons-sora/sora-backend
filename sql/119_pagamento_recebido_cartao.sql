-- =============================================================================
-- 119 — "Pagamento recebido" no CARTÃO volta a ser pagamento de fatura
--
-- O BUG: o Nubank descreve o pagamento da fatura como **"Pagamento recebido"**
-- — sem a palavra "fatura" nem "cartão". O detector por descrição
-- (`ehPagamentoFaturaDescricao`) exige as duas palavras juntas, de propósito,
-- pra "pagamento pix" não virar transferência. Resultado: essas linhas caíam
-- em `creditoAjuste` → categoria **Reembolso** → e passavam a **ABATER** a
-- fatura (services/valorFatura.js: crédito abate, pagamento é neutro).
--
-- Efeito prático: a fatura do app ficava MENOR que a do banco — exatamente a
-- queixa do cliente (app R$ 1.035,55 × banco R$ 1.788,00). Num ciclo real o
-- abatimento indevido de R$ 2.293,71 derrubou a soma pra −R$ 2.256,09.
--
-- O código já foi corrigido (services/polpCelcoinSync.normalizeTxCartao), mas
-- o sync **nunca reescreve linha existente** — é de propósito, senão apagaria
-- a categoria que o usuário corrigiu à mão. Por isso esta migration, no mesmo
-- espírito da `sql/076_recategorizar_of.sql`.
--
-- MEDIDO ANTES DE ESCREVER: 25 linhas "Pagamento recebido" em cartão de Open
-- Finance na base; 20 já estavam certas (o banco mandou o tipo estruturado) e
-- **5 estavam erradas**, somando R$ 4.694,21 abatidos indevidamente.
--
-- ⚠️ ESCOPO ESTREITO DE PROPÓSITO — só mexe em linha que é, ao mesmo tempo:
--   · Recebimento           (crédito)
--   · com `of_tx_id`        (veio do Open Finance, não foi digitada)
--   · numa carteira tipo 'Crédito'  (em CONTA, "Pagamento recebido" é receita
--     de verdade — alguém te pagou — e marcá-la como transferência a apagaria
--     do dashboard)
--   · com "pagamento recebido" na observação
-- Fora dessas quatro condições juntas, nada é tocado.
--
-- Idempotente (rodar de novo não muda mais nada).
-- Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =============================================================================

update public.transacoes t
   set categoria     = 'Fatura',
       transferencia = true
  from public.wallets w
 where t.grupo_id      = w.grupo_id
   and lower(t.carteira_nome) = lower(w.nome)
   and w.tipo          = 'Crédito'
   and t.tipo          = 'Recebimento'
   and t.of_tx_id is not null
   and t.observacao ilike '%pagamento recebido%'
   and t.categoria    <> 'Fatura';

-- Confere o resultado (deve devolver 0 linhas depois do update acima):
--   select t.id, t.data, t.carteira_nome, t.valor, t.categoria
--     from public.transacoes t
--     join public.wallets w
--       on w.grupo_id = t.grupo_id and lower(w.nome) = lower(t.carteira_nome)
--    where w.tipo = 'Crédito' and t.tipo = 'Recebimento'
--      and t.of_tx_id is not null
--      and t.observacao ilike '%pagamento recebido%'
--      and t.categoria <> 'Fatura';
