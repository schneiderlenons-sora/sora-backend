-- 047: recuperação de pagamento de assinatura recusado.
-- Quando um checkout de assinatura falha (ex.: cartão sem saldo), o webhook do
-- Stripe marca `recuperacao_pendente_em`. Um cron do backend manda o WhatsApp
-- de recuperação (link de login + cupom) e marca `recuperacao_enviada_em`
-- (dedup — só recupera uma vez por lead). Idempotente.

alter table public.users
  add column if not exists recuperacao_pendente_em timestamptz,
  add column if not exists recuperacao_enviada_em  timestamptz;
