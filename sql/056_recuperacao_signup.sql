-- 056: recuperação de cadastros sem pagamento (abandono no paywall).
-- Marca quando a Sora já mandou o WhatsApp de recuperação pra um cadastro que
-- nunca ativou plano — evita reenviar. Idempotente.

alter table public.users add column if not exists recuperacao_signup_em timestamptz;
