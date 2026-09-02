-- =============================================================================
-- 151 — Rateio: dividir um lançamento em várias categorias
--
-- Pedido de cliente: "compra de supermercado de 300 reais dividida entre
-- produtos de limpeza e alimentação".
--
-- ⚠️ NÃO EXISTE LINHA-PAI, e é isso que esta coluna NÃO faz.
--
-- O rateio SUBSTITUI a transação por N linhas normais que somam o mesmo valor.
-- `rateio_grupo` só as amarra entre si — é rótulo, não entra em cálculo nenhum.
--
-- A alternativa (guardar a linha original e pendurar filhas nela) foi recusada
-- de propósito: TODA soma do painel lê `transacoes` direto — dashboard,
-- categorias, limites, relatórios, reserva de emergência, fatura, Wrapped,
-- Previstos. Com linha-pai, os R$ 300 do supermercado virariam R$ 600 em todos
-- esses lugares, e cada uma dessas somas teria de aprender a ignorar o pai.
-- Substituindo, NENHUMA delas precisa saber que rateio existe — e por isso esta
-- migration não muda o comportamento de nada que já roda.
--
-- Aditiva e idempotente: sem esta coluna o sistema segue exatamente como está;
-- ela só passa a ser preenchida por quem usar a função.
--
-- Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =============================================================================

alter table public.transacoes
  add column if not exists rateio_grupo uuid;

comment on column public.transacoes.rateio_grupo is
  'Amarra as partes de um lançamento dividido por categoria (migration 151). Rótulo apenas — NÃO entra em nenhuma soma. O rateio substitui a transação original: não existe linha-pai.';

-- Só as linhas rateadas entram no índice; a esmagadora maioria é NULL.
create index if not exists idx_transacoes_rateio_grupo
  on public.transacoes (rateio_grupo)
  where rateio_grupo is not null;
