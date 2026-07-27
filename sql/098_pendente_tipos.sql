-- =====================================================================
-- 098 — Remove o CHECK de transacoes_pendentes.tipo_pergunta
--
-- POR QUÊ: o CHECK tinha uma lista fixa de tipos e TODO tipo novo de
-- pendente exigia uma migration pra entrar nela (022→023→026→037). Quando
-- esquecíamos, o insert falhava com
--   "violates check constraint transacoes_pendentes_tipo_pergunta_check"
-- e o criarPendente() ENGOLIA o erro (log + return null) → a pergunta era
-- enviada no WhatsApp mas o pendente NUNCA nascia, então a resposta do
-- usuário ("sim") caía na IA e virava "Olá! Como posso ajudar?".
--
-- Foi exatamente o que quebrou 'parcelamento_primeira' e 'rolar_fatura'
-- (nunca chegaram a entrar no CHECK).
--
-- tipo_pergunta é um enum INTERNO — só o nosso backend escreve nele, nunca
-- é entrada do usuário. O CHECK só nos dava falha-silenciosa sem ganho real.
-- Removendo de vez, qualquer tipo novo de pendente funciona sem migration.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.transacoes_pendentes
  drop constraint if exists transacoes_pendentes_tipo_pergunta_check;
