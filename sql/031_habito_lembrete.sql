-- =====================================================================
-- 031 — Lembrete diário de hábitos (opt-in)
--
-- Um lembrete OPCIONAL por dia, no horário escolhido pelo usuário, só pra
-- lembrar de atualizar os hábitos no app. Nada automático sem ativar.
--
--   habito_lembrete_ativo    — liga/desliga (default desligado)
--   habito_lembrete_horario  — 'HH:MM' (horário de São Paulo)
--   habito_lembrete_ultimo   — data do último envio (dedup, à prova de restart)
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.users
  add column if not exists habito_lembrete_ativo   boolean default false,
  add column if not exists habito_lembrete_horario text,
  add column if not exists habito_lembrete_ultimo  date;
