-- =====================================================================
-- 110 — Limite USADO do cartão (Open Finance)
--
-- A REGRA DE OURO da fatura (CLAUDE.md) é:
--
--     fatura = limite usado − parcelas a vencer
--
-- O limite usado é o único número que o emissor mantém correto ENQUANTO a
-- fatura está aberta. O `bill_total_amount` só aparece quando ela FECHA, e o
-- `List Bills` do emissor para na fatura passada — foi essa lacuna que fez o
-- painel somar transações e mostrar valor errado.
--
-- O sync já lia `used_amount` da API e JOGAVA FORA. Esta coluna guarda o valor
-- pra tela poder auditar de onde saiu a fatura (e pra suporte conferir sem
-- precisar chamar a API do banco).
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.wallets
  -- Limite comprometido segundo o EMISSOR (reais). Inclui parcelas a vencer —
  -- por isso a fatura desconta as futuras antes de exibir.
  add column if not exists of_limite_usado numeric;

comment on column public.wallets.of_limite_usado is
  'Open Finance: limite usado informado pelo emissor. Base da fatura em aberto (fatura = usado - parcelas a vencer). NULL = emissor não informa.';
