-- 037 — Sora Wrapped: dedup do aviso mensal no WhatsApp.
-- Guarda o último período (YYYY-MM) já avisado, pra não mandar o aviso 2x.
ALTER TABLE users ADD COLUMN IF NOT EXISTS wrapped_avisado text;
