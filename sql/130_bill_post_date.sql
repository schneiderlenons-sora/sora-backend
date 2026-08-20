-- =============================================================================
-- 130 — `transacoes.of_bill_post_date`: a data em que o BANCO lançou a compra
--
-- ⚠️ ESTA MIGRATION NÃO MUDA NENHUM VALOR NA TELA. Ela guarda um campo que hoje
-- é lido e descartado. É o passo de medição do último pedaço da divergência de
-- fatura — o mesmo caminho da sql/128.
--
-- ── O PROBLEMA QUE FALTA RESOLVER ────────────────────────────────────────────
-- O emissor agrupa a fatura pela data em que ELE LANÇOU a compra, não pela data
-- da compra. Uma compra do dia 04 processada no dia 09 entra na fatura seguinte.
-- Medido: 16 de 30 faturas listam linhas diferentes das do banco por causa disso.
--
-- O agrupamento pelo `of_bill_id` (já em produção) resolve as linhas que o
-- emissor VINCULOU — mas ele só vincula depois do fechamento, e isso é ~14% das
-- linhas. As outras 86% seguem agrupadas pela data da COMPRA, que é justamente
-- a data errada.
--
-- ── O CAMPO ──────────────────────────────────────────────────────────────────
-- O doc de /credit-cards/{id}/transactions (docs/celcoin/) define:
--
--     bill_post_date   string | null   "Data de lançamento na fatura."
--
-- É exatamente a data que decide a fatura. Nós já a recebíamos e usávamos SÓ
-- como último recurso pra preencher a data da transação:
--
--     const dataCompra = tx.transaction_date_time || tx.bill_post_date;
--
-- Guardá-la à parte permite agrupar as linhas SEM vínculo pela data que o banco
-- usa, em vez da data da compra.
--
-- ⚠️ NÃO substitui `data`. A data da transação continua sendo a da COMPRA — é
-- ela que o usuário reconhece no extrato e que o resto do painel usa
-- (dashboard, categorias, relatórios). O campo novo serve só pra decidir a
-- fatura.
--
-- Idempotente. Rodar no Supabase → SQL Editor.
-- =============================================================================

alter table public.transacoes add column if not exists of_bill_post_date date;

comment on column public.transacoes.of_bill_post_date is
  'bill_post_date do emissor: quando ELE lançou a compra na fatura. Difere da '
  'data da compra quando há atraso de processamento, e é a data que decide em '
  'qual fatura a linha entra. Ver sql/130.';

-- Índice só onde o campo existe — a maioria das linhas (manuais, OFX) fica null.
create index if not exists idx_tx_bill_post_date
  on public.transacoes(of_bill_post_date)
  where of_bill_post_date is not null;

-- =============================================================================
-- Verificação (depois de um sync):
--   select count(*) filter (where of_bill_post_date is not null) as com_data,
--          count(*) as total
--     from public.transacoes where of_tx_id is not null;
--
-- O que procurar — as linhas em que as duas datas DIFEREM são exatamente as que
-- hoje caem na fatura errada:
--   select data::date, of_bill_post_date, valor, observacao
--     from public.transacoes
--    where of_bill_post_date is not null
--      and of_bill_post_date <> data::date
--    order by data desc limit 30;
-- =============================================================================
