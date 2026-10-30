-- 191 — Chamado do tipo "dúvida".
--
-- O suporte mudou-se pra aba Ajuda (out/2026) e ganhou uma terceira porta:
-- além de "relatar um problema" e "sugerir melhoria", agora "tirar uma dúvida".
-- A coluna `tipo` (migration 053) tem CHECK com só os dois valores antigos.
--
-- Sem esta migration: a dúvida é gravada como 'problema' com o texto marcado
-- "❓ Dúvida:" (a rota cai nesse caminho sozinha) — nada se perde, só não
-- ganha o selo próprio no admin.
-- Idempotente.

alter table public.bug_reports drop constraint if exists bug_reports_tipo_check;

alter table public.bug_reports
  add constraint bug_reports_tipo_check check (tipo in ('problema', 'melhoria', 'duvida'));
