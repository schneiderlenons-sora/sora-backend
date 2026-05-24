-- =====================================================================
-- 021 — Conta padrão do usuário
-- Permite definir uma conta/cartão como "principal" — a Sora usa essa
-- automaticamente quando o usuário não menciona banco/conta nas mensagens.
-- Idempotente.
-- =====================================================================

alter table public.users
  add column if not exists wallet_padrao_id uuid references public.wallets(id) on delete set null;

create index if not exists users_wallet_padrao_idx
  on public.users (wallet_padrao_id)
  where wallet_padrao_id is not null;

-- =====================================================================
-- Verificação:
--   select id, name, wallet_padrao_id from public.users limit 5;
-- =====================================================================
