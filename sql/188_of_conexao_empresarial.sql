-- =====================================================================
-- 188 — A conexão de Open Finance é de EMPRESA (CNPJ)?
--
-- A Celcoin não devolve isso depois (nem no consentimento, nem na conta).
-- A única hora em que se sabe é ao conectar, quando a pessoa informa o CNPJ.
-- Guarda só o FATO (true/false), nunca o número do CNPJ.
--
-- Uso: conta/cartão NOVO de conexão de empresa nasce "Mercado Pago PJ" em vez
-- de "Mercado Pago (OF)" no meio das pessoais (src/services/nomeContaOf.js).
-- É também a base pra levar a conta PJ pro Sora Negócios.
--
-- NULL = conexão anterior a esta migration (não se sabe) → tratada como
-- pessoal, ou seja: nada muda pra quem já está conectado.
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.of_conexoes
  add column if not exists empresarial boolean;

comment on column public.of_conexoes.empresarial is
  'true = conectada com CNPJ (conta de empresa). NULL = anterior à 188 (não se sabe).';
