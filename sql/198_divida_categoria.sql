-- =============================================================================
-- 198 — Categoria da dívida (nov/2026)
--
-- Pedido de cliente: o "Seguro Residencial" parcelado entrava nos relatórios
-- como "Dívidas", sem como escolher "Seguros". A dívida passa a ter uma
-- categoria opcional; o pagamento de cada parcela é lançado nela.
--
-- Guarda o NOME, como transacoes.categoria e recorrencias.categoria (o sistema
-- inteiro casa categoria por nome). NULL = comportamento de antes ("Dívidas").
--
-- Sem esta migration nada quebra: as rotas gravam a dívida sem a categoria e
-- o pagamento segue em "Dívidas". Idempotente.
-- =============================================================================

alter table public.dividas add column if not exists categoria text;

comment on column public.dividas.categoria is
  'Categoria em que o pagamento das parcelas é lançado (nome, como transacoes.categoria). NULL = "Dívidas".';
