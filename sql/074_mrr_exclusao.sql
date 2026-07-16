-- =====================================================================
-- 074 — MRR mais fiel: descartar cancelados e acessos que não pagam
--
-- Duas colunas novas em `users`:
--   • assinatura_cancelada  → true quando a pessoa cancelou na Stripe
--     (cancel_at_period_end). Ela ainda tem acesso até o fim do período pago,
--     mas NÃO vai renovar → não deve entrar no MRR. Setada pelo webhook do
--     Stripe (customer.subscription.updated).
--   • mrr_excluir           → flag manual do admin. Pra acessos grátis /
--     cortesias / a própria conta do dono, que têm plano pago mas não geram
--     receita recorrente.
--
-- O MRR no /api/admin/overview passa a somar só quem paga de fato (fora
-- cancelados, excluídos manualmente, vitalícios e e-mails de admin).
-- Idempotente. Aplicar: Supabase → SQL Editor → Run.
-- =====================================================================

alter table public.users
  add column if not exists assinatura_cancelada boolean not null default false;

alter table public.users
  add column if not exists mrr_excluir boolean not null default false;

-- Só quem paga entra no MRR — índice ajuda a listagem/soma no painel.
create index if not exists idx_users_mrr
  on public.users (plano)
  where plano in ('basico', 'premium', 'black');

-- =====================================================================
-- Verificação:
--   select plano, mrr_excluir, assinatura_cancelada, count(*)
--     from public.users where plano in ('basico','premium','black')
--    group by 1,2,3 order by 1;
-- =====================================================================
