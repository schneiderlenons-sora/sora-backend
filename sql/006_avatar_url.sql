-- =====================================================================
-- 006 — Avatar do usuário (dataURL base64 ou URL de Storage)
-- Idempotente.
-- =====================================================================

alter table public.users
  add column if not exists avatar_url text;
