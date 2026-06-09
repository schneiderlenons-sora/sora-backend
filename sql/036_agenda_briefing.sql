-- =====================================================================
-- 036 — Briefing matinal da Agenda (opt-in)
--
-- Quando ativado, a Sora manda toda manhã (no horário escolhido) uma
-- mensagem no WhatsApp com TUDO que tem pra hoje, agregado de todos os
-- módulos (compromissos, consultas, contas/faturas, manutenções).
-- Dedup via agenda_briefing_ultimo (à prova de restart).
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.users
  add column if not exists agenda_briefing_ativo   boolean default false,
  add column if not exists agenda_briefing_horario text default '07:00',
  add column if not exists agenda_briefing_ultimo  date;
