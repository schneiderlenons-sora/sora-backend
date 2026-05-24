-- =====================================================================
-- 020 — Tracking de mensagem de boas-vindas no WhatsApp
-- Evita que a Sora envie a mensagem mais de uma vez por usuário.
-- Idempotente.
-- =====================================================================

alter table public.users
  add column if not exists welcomed_at timestamptz;

create index if not exists users_welcomed_at_idx
  on public.users (welcomed_at)
  where welcomed_at is null;

-- =====================================================================
-- Para reenviar a mensagem a alguém manualmente:
--   update public.users set welcomed_at = null where id = '<uuid>';
-- =====================================================================
