-- =============================================================================
-- 178 — Marca se o relato chegou a virar aviso no WhatsApp do suporte.
--
-- Relato do dono (02/10/2026): "não recebi nenhuma mensagem dos últimos
-- relatos de bugs". Medido: os relatos ESTAVAM sendo gravados (8 em 48h), ou
-- seja, o insert funcionava e quem falhava era o aviso.
--
-- ⚠️ E A FALHA ERA INVISÍVEL. O envio vivia dentro de um `catch` que só fazia
-- `console.warn`: o relato aparecia no painel, o aviso não saía, e não havia
-- como perceber a diferença sem ler log de servidor. Dias de relatos passaram
-- despercebidos por causa disso.
--
-- Com esta coluna o estado fica na própria linha: `null` = o aviso não saiu.
--
-- ⚠️ SEM ELA NADA QUEBRA: a gravação é tolerante (try/catch) e o relato
-- continua sendo salvo e notificado normalmente. Ela só devolve a visibilidade.
-- =============================================================================

alter table public.bug_reports
  add column if not exists avisado_em timestamptz;

comment on column public.bug_reports.avisado_em is
  'Quando o aviso deste relato foi entregue no WhatsApp do suporte. NULL = não foi avisado (o modelo da Meta recusou, ou o envio falhou).';

-- Relatos que ficaram sem aviso, pra conferir depois de um incidente:
--   select id, created_at, left(mensagem, 60)
--     from bug_reports where avisado_em is null order by created_at desc;
