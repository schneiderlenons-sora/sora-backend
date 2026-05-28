-- =====================================================================
-- 018 — Colunas Stripe na tabela `users`
-- Guarda o ID de cliente e assinatura do Stripe, e a data de validade
-- do plano para expiração automática.
--
-- Idempotente: pode rodar múltiplas vezes.
-- =====================================================================

alter table public.users
  add column if not exists stripe_customer_id      text,
  add column if not exists stripe_subscription_id  text,
  add column if not exists plano_intervalo          text check (plano_intervalo in ('mensal', 'anual')),
  add column if not exists plano_valido_ate         timestamptz;

-- Índice único por customer_id (null é excluído)
create unique index if not exists users_stripe_customer_id_idx
  on public.users (stripe_customer_id)
  where stripe_customer_id is not null;

-- =====================================================================
-- Verificação rápida:
--   select id, plano, stripe_customer_id, plano_valido_ate
--     from public.users limit 5;
-- =====================================================================
