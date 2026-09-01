-- =====================================================================
-- 146 — Regras completas: categorizar, renomear e NÃO CONSIDERAR
--
-- A tabela `regras_categoria` (migration 104) só sabia "termo → categoria".
-- Agora ela guarda a regra inteira que o usuário monta na tela do Watson:
--
--   CATEGORIZAR   descrição + (texto exato | contém) → categoria
--                 + renomear para (opcional)
--
-- ⚠️ NÃO EXISTE "considerar como recorrente" aqui, de propósito. Na Sora, conta
-- fixa é uma TABELA À PARTE (`recorrencias`, 458 linhas em uso) com cron,
-- lançamento automático e lembrete. A coluna `transacoes.recorrente` só faz
-- UMA coisa — dizer ao Watson "não me acuse de duplicata" (duplicadas.js:62) —
-- então um campo com esse nome na regra prometeria conta fixa e entregaria
-- outra coisa.
--
--   NÃO CONSIDERAR  descrição + (texto exato | contém)
--                   + escopo: "em tudo" ou "só na despesa/receita"
--
-- ── POR QUE `ignorar_em` FICA NA TRANSAÇÃO, E NÃO SÓ NA REGRA ───────────────
-- Toda a matemática de dinheiro da Sora lê TRANSAÇÃO, não regra: o resumo
-- (`resumoTransacoes.ehTransferencia`), o porte fiel do SSR (`lib/ssr-data.ts`)
-- e a fatura (`valorFatura.valorNaFatura`). Se "não considerar" morasse só na
-- regra, cada um desses pontos teria de carregar e casar as regras por conta
-- própria — três lugares para divergir, que é exatamente o defeito que já
-- custou semanas na fatura do cartão. A regra CARIMBA a transação; os cálculos
-- continuam olhando uma coluna.
--
--   'fluxo' → sai de receitas/despesas (o "só na despesa/receita" do print)
--   'tudo'  → sai também da fatura (o "em tudo")
--
-- ⚠️ NULL = comportamento de hoje. Todas as 13.9k transações existentes ficam
-- NULL, então nada muda para ninguém até alguém criar uma regra de ignorar.
--
-- ⚠️ SEM CHECK CONSTRAINT nos valores, de propósito. Três incidentes desta base
-- (users_plano_check, investimentos_tipo_check, dividas_tipo_check) foram
-- gravação falhando CALADA por causa de CHECK. A validação fica no código.
--
-- ⚠️ `categoria` VIRA NULLABLE: regra de "não considerar" não tem categoria.
--
-- Idempotente.
-- =====================================================================

-- ── A regra ──────────────────────────────────────────────────────────
alter table public.regras_categoria
  add column if not exists tipo           text    not null default 'categorizar',
  -- 'contem' é o default porque é a semântica que as regras antigas já tinham
  -- (`categoriaPorRegra` casa nos dois sentidos). Mudar o default para 'exato'
  -- silenciosamente estreitaria regras que já existem.
  add column if not exists modo_match     text    not null default 'contem',
  add column if not exists renomear_para  text,
  add column if not exists ignorar_escopo text;

comment on column public.regras_categoria.tipo is
  '"categorizar" ou "ignorar". Ignorar carimba transacoes.ignorar_em.';
comment on column public.regras_categoria.modo_match is
  '"exato" (descrição idêntica, sem acento/caixa) ou "contem" (substring).';
comment on column public.regras_categoria.renomear_para is
  'Novo nome do lançamento. NULL = mantém a descrição do banco.';
comment on column public.regras_categoria.ignorar_escopo is
  '"tudo" (somas + fatura) ou "fluxo" (só despesa/receita). Só com tipo=ignorar.';

-- Regra de ignorar não tem categoria.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'regras_categoria'
       and column_name = 'categoria' and is_nullable = 'NO'
  ) then
    alter table public.regras_categoria alter column categoria drop not null;
  end if;
end $$;

-- ── O carimbo na transação ───────────────────────────────────────────
alter table public.transacoes
  add column if not exists ignorar_em text;

comment on column public.transacoes.ignorar_em is
  'NULL = conta normalmente. "fluxo" = fora de receitas/despesas. "tudo" = fora também da fatura. Carimbado por regra de "não considerar" (146).';

-- Índice parcial: só as ignoradas, que são a minoria absoluta.
create index if not exists idx_transacoes_ignorar_em
  on public.transacoes (grupo_id, ignorar_em)
  where ignorar_em is not null;

-- =====================================================================
-- Verificação:
--   select tipo, modo_match, count(*) from public.regras_categoria group by 1,2;
--   -- esperado: todas 'categorizar'/'contem' (as antigas, se houver)
--
--   select count(*) from public.transacoes where ignorar_em is not null;
--   -- esperado: 0 — esta migration não reescreve nenhuma transação
-- =====================================================================
