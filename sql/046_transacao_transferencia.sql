-- 046: marca transações que são TRANSFERÊNCIA / quitação de dívida (não consumo).
-- Hoje: pagamento de fatura do cartão. Futuro: transferências entre contas.
-- Transferências ficam fora dos relatórios de gasto por categoria (senão
-- duplicam as compras do cartão, que já entram nas categorias reais).
-- Idempotente.

alter table public.transacoes
  add column if not exists transferencia boolean not null default false;

-- Backfill: pagamentos de fatura já registrados viram transferência.
update public.transacoes
   set transferencia = true
 where categoria = 'Fatura cartão'
   and transferencia = false;

-- Acelera os relatórios que filtram fora as transferências.
create index if not exists idx_transacoes_transferencia
  on public.transacoes (grupo_id, transferencia);
