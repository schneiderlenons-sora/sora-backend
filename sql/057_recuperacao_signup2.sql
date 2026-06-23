-- 057: 2º lembrete de recuperação de cadastro sem pagamento.
-- Marca quando a Sora mandou o SEGUNDO WhatsApp (cupom SORA25, mais agressivo)
-- pra quem já recebeu o 1º e continua sem pagar. Idempotente.

alter table public.users add column if not exists recuperacao_signup2_em timestamptz;
