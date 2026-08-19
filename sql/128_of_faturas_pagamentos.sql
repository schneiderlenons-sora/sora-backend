-- =============================================================================
-- 128 — `of_faturas.pagamentos`: as datas dos pagamentos que o banco manda
--
-- ⚠️ ESTA MIGRATION NÃO MUDA NENHUM VALOR NA TELA. Ela só passa a GUARDAR um
-- dado que hoje é lido e jogado fora. É o passo de medição de um bug que já
-- está confirmado, mas cuja correção ainda não é segura.
--
-- ── O BUG ────────────────────────────────────────────────────────────────────
-- O emissor manda, dentro de cada fatura, um `payments[]` com { amount,
-- paymentDate, valueType, paymentMode }. Nós somamos SÓ o `amount`
-- (`faturasBanco.pagoDaBill`) e descartamos a data. Esse total vira
-- `of_faturas.pago`, e a tela faz `restante = total − pago`.
--
-- Só que em parte dos emissores o `payments[]` de uma fatura são os pagamentos
-- feitos DURANTE o ciclo dela — que quitam a fatura ANTERIOR. Confirmado com
-- data, não por suposição:
--
--   Cartão EQI BLACK · fatura 2026-08 · fecha 2026-08-15 · total R$ 3.517,11
--     `pago` informado ......... R$ 4.359,17
--     pagamento correspondente . 2026-07-20   ← 26 DIAS ANTES do fechamento
--     total da fatura ANTERIOR . R$ 4.364,17  (a diferença de R$ 5,00 é o cashback)
--
--   Um pagamento feito em 20/07 não pode quitar uma fatura que só fechou em
--   15/08 — ela nem existia. Ele quitou a de julho, que venceu em 19/07.
--
-- Medido na base: dos 26 pares que dá pra conferir contra a transação real,
-- **4 têm o pagamento ANTES do próprio fechamento** (EQI BLACK ×2, platinum ×2)
-- e 22 são coerentes. Por cartão: 7 de 21 cartões invertem (família Itaú + EQI).
--
-- ── POR QUE NÃO CORRIGI JUNTO ────────────────────────────────────────────────
-- Havia duas saídas e as duas regridem hoje:
--
--   1. Inverter globalmente → quebra os 22 pares em que o banco está certo.
--   2. Trocar a fonte pela NOSSA atribuição (`pagamentos_fatura`, que já casa
--      cada pagamento com o vencimento mais próximo) → medido: bate em 20
--      faturas, diverge em 20 (a nossa costuma bater melhor com o total), MAS
--      **180 faturas têm `pago > 0` do banco e NENHUM registro nosso** — elas
--      apareceriam como não pagas. Regressão grande e visível.
--
-- O que falta pra decidir é justamente o campo que jogamos fora: com a DATA de
-- cada pagamento dá pra atribuir cada um à competência certa (a mesma regra de
-- `faturaRollover.competenciaDoPagamento`: o vencimento mais próximo da data
-- do pagamento) e as duas objeções acima desaparecem.
--
-- Depois de rodar isto, o próximo sync popula a coluna e a correção passa a ser
-- mensurável ANTES de ser ligada.
--
-- Idempotente. Rodar no Supabase → SQL Editor.
-- =============================================================================

alter table public.of_faturas add column if not exists pagamentos jsonb;

comment on column public.of_faturas.pagamentos is
  'payments[] cru do emissor: [{valor, data, tipo, modo}]. A coluna `pago` é a '
  'SOMA deles e ignora a data — ver sql/128. Guardado pra permitir atribuir '
  'cada pagamento à competência certa.';

-- =============================================================================
-- Verificação (depois de um sync):
--   select competencia, total, pago, pagamentos
--     from public.of_faturas
--    where pagamentos is not null
--    order by competencia desc limit 20;
--
-- O que procurar: pagamento cuja `data` é ANTERIOR ao `fechamento` da própria
-- fatura — é o sintoma do bug.
-- =============================================================================
