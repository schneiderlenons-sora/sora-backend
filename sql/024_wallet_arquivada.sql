-- 024_wallet_arquivada.sql
-- Adiciona coluna `arquivada` na tabela wallets.
-- O frontend e o backend referenciavam essa coluna mas ela nunca existiu,
-- o que quebrava listagens (query falhava → bot achava que não havia contas).

ALTER TABLE wallets
  ADD COLUMN IF NOT EXISTS arquivada boolean NOT NULL DEFAULT false;
