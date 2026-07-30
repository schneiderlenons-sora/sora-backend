-- =====================================================================
-- 102 — Por que o pagamento falhou (recuperação de venda)
--
-- `recuperacao_pendente_em` (migration 047) já marcava QUANDO o pagamento foi
-- recusado, mas não O QUÊ — e o motivo muda a abordagem de recuperação:
--   · cc_rejected_high_risk        → antifraude: pedir outro cartão ou Pix
--   · cc_rejected_insufficient_amount → sem limite: sugerir parcelar ou Pix
--   · cc_rejected_bad_filled_*     → digitou errado: só refazer
--   · cc_rejected_call_for_authorize → o banco precisa liberar
-- O Mercado Pago manda isso em `status_detail`; era descartado no log.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.users add column if not exists recuperacao_motivo text;

-- Lista "pagamento falhou" do painel admin = ordenar por esta data.
create index if not exists idx_users_recuperacao_pendente
  on public.users(recuperacao_pendente_em) where recuperacao_pendente_em is not null;
