-- =====================================================================
-- 081 — Bíblia · Fase 3 (WhatsApp): opt-in do versículo do dia
--
-- Colunas em users pro envio proativo do versículo do dia no WhatsApp.
-- Opt-in por WhatsApp ("ativar versículo diário"). Default DESLIGADO.
-- Reusa o template `lembretes_gerais` (já aprovado) — sem template novo.
-- Idempotente. Aplicar: Supabase → SQL Editor → Run.
-- =====================================================================

alter table public.users
  add column if not exists biblia_versiculo_ativo boolean not null default false,
  add column if not exists biblia_versiculo_em    date;   -- dedup do envio (1x/dia)

-- =====================================================================
-- Verificação:
--   select id, biblia_versiculo_ativo, biblia_versiculo_em
--     from public.users where biblia_versiculo_ativo;
-- =====================================================================
