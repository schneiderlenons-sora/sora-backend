-- =============================================================================
-- 120 — Caixinhas (saldos reservados) no trilho CELCOIN
--
-- A tabela `of_caixinhas` já existe desde a 069, mas só era escrita pelo trilho
-- PLUGGY legado (`services/polpSync.js`). No trilho Celcoin — que é o que roda
-- hoje — ela nunca recebeu uma linha: MEDIDO, 0 registros com 14 conexões
-- ativas (5 delas Nubank).
--
-- A Polp publicou `GET /accounts/{account}/reserved-balances`, que é como as
-- "Caixinhas" do Nubank chegam pelo Open Finance. Esta migration só adiciona as
-- colunas que o endpoint novo traz e que a 069 não previa.
--
-- ⚠️ POR QUE ISSO É DINHEIRO QUE SUMIA DA TELA: a doc de `GET /accounts/{id}`
-- diz, sobre `balance.available_amount`, que ele "não inclui cheque especial,
-- investimentos automáticos nem reservas de saldo". Ou seja, o dinheiro da
-- caixinha NÃO está no saldo da conta que a Sora já mostra — quem tem R$ 5.000
-- guardados em caixinhas simplesmente não os via em lugar nenhum do painel.
-- Como o saldo da conta os exclui, somar a caixinha à parte NÃO duplica nada.
--
-- Idempotente. Rodar no Supabase → SQL Editor.
-- =============================================================================

-- Vínculo com a conta de origem (uma conta tem N caixinhas).
alter table public.of_caixinhas add column if not exists of_conta_id text;

-- Remuneração da reserva, quando o banco informa (a caixinha do Nu rende CDI).
-- Espelha `available_amount[].remuneration` da Celcoin.
alter table public.of_caixinhas add column if not exists indexador       text;      -- CDI, SELIC, IPCA…
alter table public.of_caixinhas add column if not exists indexador_pct   numeric(10,4); -- % do indexador (ex.: 100 = 100% do CDI)
alter table public.of_caixinhas add column if not exists taxa_pre        numeric(10,4); -- taxa pré-fixada (%)
alter table public.of_caixinhas add column if not exists rate_type       text;      -- LINEAR | EXPONENCIAL
alter table public.of_caixinhas add column if not exists periodicidade   text;      -- MENSAL | ANUAL | DIARIO | SEMESTRAL
alter table public.of_caixinhas add column if not exists calculo         text;      -- DIAS_UTEIS | DIAS_CORRIDOS

create index if not exists idx_of_caixinhas_conta on public.of_caixinhas(of_conta_id);

-- =============================================================================
-- Verificação:
--   select nome, saldo, indexador, indexador_pct from public.of_caixinhas;
-- =============================================================================
