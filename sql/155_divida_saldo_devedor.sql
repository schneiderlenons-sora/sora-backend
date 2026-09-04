-- =============================================================================
-- 155 — `dividas.saldo_devedor`: o saldo devedor que o BANCO informa.
--
-- RELATO DE ORIGEM: o card mostrava SALDO DEVEDOR R$ 28.165,88 num empréstimo
-- em que o próprio emissor manda `contract_outstanding_balance: 9069.95` — e a
-- observação da dívida, que a Sora já escreve, dizia "Saldo devedor: R$
-- 9069.95". O painel contradizia o próprio texto ao lado.
--
-- A conta antiga é `(parcelas_total - parcelas_pagas) × valor_parcela`. Ela é
-- o melhor possível numa dívida lançada à mão, mas aqui erra por dois motivos:
--
--   1. mede outra coisa — é a soma do que ainda vai ser PAGO ao longo do
--      contrato (com os juros futuros dentro), não o valor de quitação hoje,
--      que é o que qualquer app de banco chama de saldo devedor;
--   2. depende de `parcelas_pagas`, e essa contagem vem furada do emissor:
--      medido nesta base, um contrato cuja PRIMEIRA parcela ainda não venceu
--      chega com "11 de 48 pagas" e saldo devedor MAIOR que o contratado.
--
-- NULL em dívida manual — lá a conta antiga continua valendo, sem mudança.
-- =============================================================================

alter table dividas add column if not exists saldo_devedor numeric;

comment on column dividas.saldo_devedor is
  'Saldo devedor informado pelo emissor (Open Finance, contract_outstanding_balance) — valor de quitação hoje. NULL em dívida manual, onde o painel calcula parcelas restantes × valor da parcela.';
