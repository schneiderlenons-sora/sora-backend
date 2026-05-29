-- 025_meta_alerta_enviado.sql
-- Flag para o alerta do limite GERAL (meta_mensal) não repetir no mesmo mês.
-- Guarda o mês de referência (YYYY-MM) do último alerta enviado.
-- Como o valor muda a cada mês, o alerta reseta automaticamente.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS meta_mensal_alerta_enviado text;
