-- =====================================================================
-- 144 — Conta em moeda estrangeira (Nomad, Wise, Revolut, Avenue…)
--
-- Pedido de cliente: "conta Nomad onde tem investimento ou dólar guardado,
-- não tenho a opção de escolher a moeda em DOLAR".
--
-- ⚠️ A MOEDA MORA NA CARTEIRA, NÃO NA TRANSAÇÃO. Uma conta Nomad é INTEIRAMENTE
-- em dólar — toda transação dela é em dólar. Moeda por transação exigiria tocar
-- os 56 arquivos que formatam BRL e os 61 pontos que leem saldo; moeda por
-- carteira resolve o mesmo problema mexendo em ~11 pontos de agregação.
--
-- ⚠️ `transacoes.valor` CONTINUA SEMPRE EM BRL. Esta é a decisão que torna a
-- mudança segura: dashboard, categorias, relatórios, limites, Wrapped e Oráculo
-- somam `valor` e seguem CORRETOS sem uma linha alterada. O valor nativo vai em
-- `valor_moeda` e a taxa usada em `taxa_brl`.
--
-- ⚠️ A TAXA É CONGELADA NA ENTRADA. Se a conversão fosse feita na hora de
-- exibir, o "gasto de março" mudaria todo dia junto com o câmbio e relatório
-- fechado se mexeria sozinho. `taxa_brl` prende março em março; só o SALDO da
-- conta acompanha o câmbio, que é o comportamento certo.
--
-- ⚠️ SEM CHECK CONSTRAINT na moeda, de propósito. Três incidentes desta base
-- (users_plano_check, investimentos_tipo_check, dividas_tipo_check) foram
-- exatamente isto: valor novo na aplicação que o CHECK recusava, e a gravação
-- falhando CALADA. A normalização (3 letras, maiúsculas) fica no código.
--
-- Impacto medido antes de rodar: 7 carteiras com nome de conta internacional
-- (Revolut, Wise, Nomad) em 6 grupos, somando 11 transações, NENHUMA vinda do
-- Open Finance. Todas as 455 carteiras nascem 'BRL' e nada muda pra elas.
--
-- Idempotente.
-- =====================================================================

-- ── Carteira: qual moeda ela guarda ──────────────────────────────────
-- `saldo` passa a ser NATIVO (em BRL isso não muda nada: nativo já era BRL).
alter table public.wallets
  add column if not exists moeda text not null default 'BRL';

comment on column public.wallets.moeda is
  'Moeda nativa da carteira (ISO 4217, ex.: BRL, USD, EUR). O `saldo` está NESTA moeda.';

-- ── Transação: o valor nativo e a taxa do dia em que ela aconteceu ───
-- `valor` continua em BRL. Estas três colunas são ADITIVAS: null = BRL puro,
-- que é o estado de todas as 13.4k linhas existentes.
alter table public.transacoes
  add column if not exists moeda text,
  add column if not exists valor_moeda numeric,
  add column if not exists taxa_brl numeric;

comment on column public.transacoes.valor is
  'SEMPRE em BRL. Em carteira estrangeira é valor_moeda * taxa_brl, congelado na entrada.';
comment on column public.transacoes.moeda is
  'Moeda em que a transação foi feita. NULL = BRL (o caso da esmagadora maioria).';
comment on column public.transacoes.valor_moeda is
  'Valor na moeda nativa. NULL = igual a `valor` (BRL).';
comment on column public.transacoes.taxa_brl is
  'Câmbio congelado no momento do lançamento. NULL = 1. Impede o histórico de mudar sozinho.';

-- Índice só onde existe moeda estrangeira — parcial, custa quase nada.
create index if not exists idx_transacoes_moeda
  on public.transacoes (grupo_id, moeda)
  where moeda is not null;

-- =====================================================================
-- Verificação:
--   select moeda, count(*) from public.wallets group by moeda;
--   -- esperado: BRL = todas (nenhuma conta muda sozinha)
--   select count(*) from public.transacoes where moeda is not null;
--   -- esperado: 0 (nada é reescrito por esta migration)
-- =====================================================================
