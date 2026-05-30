-- =====================================================================
-- 027 — Dedup de avisos de fatura (por cartão)
-- A Sora avisa quando a fatura FECHA e quando VENCE, oferecendo pagar.
-- O job roda de hora em hora; estas colunas evitam reenviar o mesmo
-- aviso várias vezes no mesmo dia (uma por cartão, não global no user).
-- Idempotente.
-- =====================================================================

alter table public.wallets
  add column if not exists ultimo_aviso_fechamento date,
  add column if not exists ultimo_aviso_vencimento date;

-- =====================================================================
-- Verificação:
--   select nome, dia_fechamento, dia_vencimento,
--          ultimo_aviso_fechamento, ultimo_aviso_vencimento
--     from public.wallets where tipo = 'Crédito';
-- =====================================================================
