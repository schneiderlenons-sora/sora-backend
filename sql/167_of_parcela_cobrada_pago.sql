-- =============================================================================
-- 167 — parcela do Open Finance já cobrada deixa de ficar "não paga"
--
-- A parcela futura é importada com pago = false (ainda não foi cobrada), e o
-- sync só a reescrevia quando a DATA divergia. A que já nasceu na data certa
-- ficava "não paga" pra sempre depois de cobrada. Relato: o comando "parcelas"
-- listou JIM.COM PROSED ES como a pagar, com as duas parcelas cobradas.
--
-- O sync agora refresca o `pago` (patchReconciliacaoParcela), mas só alcança
-- as transações que o banco ainda devolve. Isto corrige o histórico.
--
-- Medido em 14/09/2026: 30 linhas, R$ 14.270,19, 13 clientes.
--
-- ⚠️ ESCOPO ESTREITO DE PROPÓSITO:
--   · só Open Finance (of_tx_id) — o banco é a verdade de que a parcela passou;
--   · só parcela (parcela_total) — outra linha não paga do OF não é deste bug;
--   · as 240 parcelas digitadas à mão NÃO entram: o comando já as trata pela
--     data, e mudar dado do usuário é decisão à parte.
-- ⚠️ Não mexe em saldo: carteira de Open Finance tem o saldo do banco.
--
-- "Dia da transação" com a mesma regra de lib/data-br.ts: meia-noite UTC é
-- data pura; qualquer outra hora é instante, lido em São Paulo.
-- Idempotente.
-- =============================================================================

update public.transacoes t
   set pago = true
 where t.of_tx_id is not null
   and t.parcela_total is not null
   and t.pago = false
   and (
     case
       when (t.data at time zone 'UTC')::time = time '00:00'
         then (t.data at time zone 'UTC')::date
       else (t.data at time zone 'America/Sao_Paulo')::date
     end
   ) <= (now() at time zone 'America/Sao_Paulo')::date;
