-- =====================================================================
-- 044 — Resumos proativos no WhatsApp (semanal + fechamento mensal).
-- Independentes do Wrapped. Opt-out: colunas resumo_*; dedup à prova de
-- restart via resumo_*_em. Idempotente. Aplicar: Supabase → SQL Editor.
-- =====================================================================

alter table public.users add column if not exists resumo_semanal    boolean default true;
alter table public.users add column if not exists resumo_mensal      boolean default true;
-- Dedup: última data (YYYY-MM-DD) do envio semanal e mês (YYYY-MM) do envio mensal.
alter table public.users add column if not exists resumo_semanal_em  date;
alter table public.users add column if not exists resumo_mensal_em   text;
