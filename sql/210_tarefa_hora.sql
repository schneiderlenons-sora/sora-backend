-- =============================================================================
-- 210 — Horário OPCIONAL na tarefa
--
-- Pedido de cliente: escolher se a tarefa tem horário marcado ou não.
--
-- ⚠️ Texto 'HH:MM' numa coluna própria, e NÃO dentro de `data_vencimento`
-- (que é timestamptz e é lido pelos 10 primeiros caracteres): misturar a hora
-- ali traria o fuso pra dentro da data. Nulo = sem horário.
--
-- Aplicar: Supabase Dashboard → SQL Editor → Run. Idempotente.
-- =============================================================================

alter table public.tarefas add column if not exists hora text;

alter table public.tarefas drop constraint if exists tarefas_hora_formato;
alter table public.tarefas add constraint tarefas_hora_formato
  check (hora is null or hora ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
