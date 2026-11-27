-- =============================================================================
-- 208 — DATA TRAVADA na transação do Open Finance.
--
-- O sync reescreve a data das parcelas já importadas pelo `charge_identificator`
-- (parcela N = compra + N−1 meses — `reconciliarParcelas`). Isso está certo pra
-- quase tudo, mas não pra compra ESTORNADA que o banco cobrou toda de uma vez:
-- aí o deslocamento espalha pelos meses seguintes parcelas que o banco já
-- cobrou (e estornou) numa fatura passada.
--
-- Medido em 27/11/2026 em 616 faturas publicadas: nenhuma regra automática
-- separa esse caso com segurança do mecanismo de parcelamento dos outros
-- bancos (que também lança um "estorno" do valor total no dia da compra). Por
-- isso a correção é pontual, a partir do dado do próprio banco, e a linha
-- corrigida fica TRAVADA: a reconciliação não mexe nela.
--
-- Rodar de novo é seguro.
-- =============================================================================
alter table transacoes add column if not exists data_travada boolean not null default false;

-- Caso que motivou (cliente do relato de 27/11/2026, cartão PicPay): compra de
-- 6x R$ 425,59 estornada em 23/09 (crédito de R$ 2.553,54); o banco lançou as
-- parcelas 2–6 e o estorno na fatura de outubro (bill 01a216ec-…-7c6f28798277,
-- lançamento 24/09). As parcelas 3–6 foram corrigidas pra 24/09 e ficam travadas.
update transacoes set data_travada = true
where grupo_id = 'b96ebbd9-6fe2-4714-a27b-cf909c5b91f5'
  and of_tx_id in (
    '01a20211-991c-72a8-9626-56c4ffc0d7f0',   -- 3/6
    '01a20211-990a-7368-b030-6b777efd7900',   -- 4/6
    '01a20211-9917-7093-a0ae-aa786081d016',   -- 5/6
    '01a20211-9912-712b-83e8-5e2531e0f3a2'    -- 6/6
  );
