-- 055: toggle mestre de avisos da Sora (kill-switch).
-- Quando false, a Sora não dispara NENHUM aviso proativo (lembretes, resumos,
-- fatura, limites, hábitos, briefing, etc.). Default true (comportamento atual).
-- Os toggles individuais (habito_lembrete_ativo, resumo_*, agenda_briefing_*,
-- lembretes_ativos, lembretes_dividas) continuam valendo dentro disso.
-- Idempotente.

alter table public.users add column if not exists avisos_ativos boolean not null default true;
