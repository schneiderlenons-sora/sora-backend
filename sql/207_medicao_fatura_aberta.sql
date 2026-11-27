-- =============================================================================
-- 207 — MEDIÇÃO da fatura em aberto (só medição; nada na tela lê isto).
--
-- Relato do Breno (27/11/2026): a marcação de fatura que o EMISSOR põe em cada
-- transação (`bill_forecast_date`) acertou ao centavo as faturas em aberto dos
-- três cartões dele (Nubank, Mercado Pago, PicPay), onde a Sora errava. Na base
-- inteira ela não serve pra todo banco (discorda da tela em 84 de 109 cartões).
--
-- Antes de usá-la POR BANCO, medimos: todo dia às 23h30 (SP) o JOB 1V grava,
-- por cartão do Open Finance, o que a Sora mostra e o que a marcação do banco
-- daria. Quando o banco publica a fatura, `GET /api/open-finance/diag-medicao`
-- compara o último retrato antes do fechamento com o total publicado.
--
-- Sem policy de propósito: só o service role (backend) lê e grava.
-- Rodar de novo é seguro.
-- =============================================================================
create table if not exists medicao_fatura_aberta (
  id            bigserial primary key,
  cartao_id     uuid not null,
  grupo_id      uuid not null,
  instituicao   text,
  competencia   text not null,              -- 'AAAA-MM' do VENCIMENTO (convenção da Sora)
  dia           date not null,              -- dia de São Paulo do retrato
  sora_fatura   numeric(14,2),              -- o valor da fatura que a tela mostra
  sora_restante numeric(14,2),              -- fatura − pago, como no card
  marca_banco   numeric(14,2),              -- soma das linhas sem bill_id marcadas pelo banco pra esta competência
  marca_linhas  integer,
  criado_em     timestamptz not null default now(),
  unique (cartao_id, competencia, dia)
);

create index if not exists medicao_fatura_aberta_cartao_idx
  on medicao_fatura_aberta (cartao_id, competencia);

alter table medicao_fatura_aberta enable row level security;
