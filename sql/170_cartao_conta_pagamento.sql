-- =============================================================================
-- 170 — De qual CONTA sai o pagamento da fatura de cada cartão.
--
-- Pedido de cliente (set/2026): "no extrato de previstos não está considerando
-- os valores de cartão de crédito — mas para isso preciso dizer em qual banco
-- irei pagá-los". O Extrato Futuro projeta o saldo POR CONTA; sem saber de
-- onde sai o dinheiro, a fatura não tinha em que conta cair.
--
-- ⚠️ Liga por ID, não por nome: renomear a conta não pode desligar a escolha
-- (o resto do painel liga conta a lançamento por nome, e renomear cascateia
-- só `transacoes` e `recorrencias`).
-- ⚠️ ON DELETE SET NULL: apagar a conta de pagamento não apaga o cartão — a
-- fatura só volta a ficar "sem conta" até a pessoa escolher outra.
--
-- Idempotente. Sem ela o painel segue funcionando: a fatura entra no extrato
-- em "Todas as contas" e o seletor de conta avisa que falta esta migration.
-- =============================================================================
alter table public.wallets
  add column if not exists conta_pagamento_id uuid
  references public.wallets(id) on delete set null;
