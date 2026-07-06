-- =====================================================================
-- 064 — Intenção do vitalício (pra recuperação levar de volta pra oferta certa).
-- Guarda o tier que o usuário tentou/estava comprando ('kit' | 'completa' |
-- 'upgrade'). A recuperação usa isso pra apontar o link pro checkout do vitalício
-- (em vez do /login genérico). Setado no checkout do vitalício e no /process do MP.
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.users add column if not exists vitalicio_intent text;
