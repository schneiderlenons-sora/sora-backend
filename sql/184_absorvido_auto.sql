-- 184_absorvido_auto.sql
-- =============================================================================
-- Marca quando uma PREVISÃO MANUAL foi absorvida automaticamente pela cobrança
-- real do banco no sync do Open Finance (a cobrança assume a previsão em vez de
-- virar linha nova). É o que alimenta a lista "juntados automaticamente ·
-- desfazer" no Detetive Watson.
--
-- ⚠️ ADITIVA e TOLERANTE: sem esta coluna a absorção AINDA acontece (o código
-- refaz o update sem o marco) — só não entra na lista de desfazer. Então rodar
-- isto é opcional pro recurso funcionar, obrigatório pro "desfazer" aparecer.
--
-- Nada de índice: a lista lê só os últimos 7 dias do próprio grupo, volume
-- ínfimo (medido: ~1 absorção na base inteira).
-- =============================================================================

ALTER TABLE transacoes
  ADD COLUMN IF NOT EXISTS absorvido_auto_em timestamptz;

COMMENT ON COLUMN transacoes.absorvido_auto_em IS
  'Quando esta previsão manual assumiu a cobrança do banco (absorção automática do sync). NULL = não foi absorvida. Soltar (NULL) + pago=false desfaz.';
