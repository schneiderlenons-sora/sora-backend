-- =====================================================================
-- 138 — investimentos guardam o que o Open Finance já mandava e a Sora jogava fora
--
-- Lendo os 5 docs de investimento da Celcoin (bank-fixed-incomes, credit-,
-- funds, treasure-titles, variable-incomes), o `balance` de TODAS as famílias
-- traz três coisas que nunca foram gravadas:
--
--   income_tax / income_tax_provision ........ IR já provisionado
--   financial_transaction_tax ................ IOF
--   blocked_balance / blocked_amount ......... saldo bloqueado
--
-- E a renda fixa bancária — que é onde vive TODA caixinha de banco digital —
-- traz ainda:
--
--   grace_period_date ........................ carência pra resgate antecipado
--   issue_date ............................... emissão do título
--
-- ⚠️ A CARÊNCIA É O CAMPO MAIS IMPORTANTE DESTA MIGRATION. Quem guarda dinheiro
-- em caixinha faz UMA pergunta: "posso sacar sem perder?". A resposta chegava
-- em todo sync e era descartada.
--
-- ⚠️ IR E IOF NÃO SE SOMAM AO PATRIMÔNIO NEM SE SUBTRAEM DELE. O `net_amount`,
-- que já é o nosso `valor_atual`, VEM líquido dos dois — descontar de novo
-- tiraria o valor em dobro. Estas colunas existem pra EXPLICAR o número
-- ("dos R$ 2.642,80, R$ X já são de IR"), não pra recalculá-lo.
--
-- Idempotente.
-- =====================================================================

alter table public.investimentos
  -- Bruto, pra tela poder mostrar a diferença pro líquido que já exibimos.
  add column if not exists valor_bruto      numeric,
  add column if not exists ir_provisionado  numeric,
  add column if not exists iof_provisionado numeric,
  add column if not exists saldo_bloqueado  numeric,
  -- Data até quando o resgate antecipado tem penalidade (renda fixa bancária).
  add column if not exists carencia_ate     date,
  add column if not exists data_emissao     date,
  -- Quem emitiu o papel. Sem isto o card não tem como dizer "Nubank".
  add column if not exists instituicao      text,
  -- Fundos: classificação ANBIMA (Multimercado, Renda Fixa, Ações…).
  add column if not exists categoria_anbima text;

comment on column public.investimentos.carencia_ate is
  'Fim da carência pra resgate antecipado (grace_period_date do Open Finance). Antes dela, resgatar costuma custar rendimento.';
comment on column public.investimentos.ir_provisionado is
  'IR já provisionado pelo emissor. NÃO descontar do valor_atual — ele já vem líquido (net_amount).';

-- ── Conferência (rodar solto, depois de um sync) ──────────────────────
-- select tipo, count(*),
--        count(carencia_ate)     as com_carencia,
--        count(ir_provisionado)  as com_ir,
--        count(instituicao)      as com_instituicao
--   from public.investimentos where origem = 'of' group by tipo;
