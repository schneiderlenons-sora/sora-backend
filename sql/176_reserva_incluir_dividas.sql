-- =============================================================================
-- 176 — Reserva de emergência passa a considerar as parcelas de dívida.
--
-- Relato de cliente (26/09/2026): "na parte de conta de reserva ele não está
-- considerando o que tem em dívidas e parcelas".
--
-- A meta da reserva sai de `gasto médio dos últimos 6 meses × N meses`, e esse
-- gasto médio só enxerga TRANSAÇÃO. Quem tem financiamento cadastrado na aba
-- Dívidas e não lança o pagamento fica com a meta subestimada. Medido na conta
-- do relato: três financiamentos somando R$ 6.296,91/mês — mais que todo o
-- resto do custo de vida dele — e nenhum pagamento lançado. A meta de 6 meses
-- saía R$ 29.577,83 onde o correto é R$ 67.359,29.
--
-- ⚠️ DEFAULT `true`: o cálculo COM as parcelas é o correto (se a renda acaba,
-- a parcela continua). Quem já lança o pagamento não é afetado — o serviço
-- `custoMensalDividas` detecta e não soma duas vezes — e quem quiser desligar
-- tem o toggle na tela.
--
-- ⚠️ SEM ELA a reserva continua funcionando exatamente como antes: a rota lê
-- `incluir_dividas` de forma tolerante e o POST avisa que a migration falta em
-- vez de dizer que salvou.
--
-- Raio de impacto medido em 30/09/2026: 36 grupos têm dívida ativa; em 30
-- deles a meta muda.
-- =============================================================================

alter table public.reserva_emergencia_config
  add column if not exists incluir_dividas boolean not null default true;

comment on column public.reserva_emergencia_config.incluir_dividas is
  'Somar as parcelas de dívidas manuais ao custo mensal da reserva. O serviço custoMensalDividas ignora as que já aparecem nos gastos, as do Open Finance e o rotativo do cartão.';
