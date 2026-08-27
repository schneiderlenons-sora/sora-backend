-- =====================================================================
-- 139 — movimentações dos investimentos (aportes, resgates e proventos)
--
-- As 5 famílias de investimento da Celcoin expõem `/{familia}/{id}/transactions`
-- e a Sora nunca chamou — `listarTransacoesInvestimento` existia em
-- `services/polpCelcoin.js`, exportada, sem nenhum chamador. Por isso a aba
-- Aportes vive vazia, o card "Dividendos" mostra R$ 0,00 e o gráfico de
-- Evolução diz "histórico será gerado conforme você adicionar investimentos":
-- não existia série temporal nenhuma.
--
-- ⚠️ NEM TODA MOVIMENTAÇÃO É DINHEIRO ENTRANDO OU SAINDO. Lendo os enums dos
-- 5 docs, `TRANSFERENCIA_TITULARIDADE`, `TRANSFERENCIA_CUSTODIA` e
-- `TRANSFERENCIA_COTAS` são o papel MUDANDO DE CORRETORA — o dinheiro não se
-- move. Tratá-las como aporte inflaria o total investido de quem portou a
-- carteira, e a rentabilidade (que sai de valor − aportado) desabaria junto.
-- Por isso `classe` guarda a leitura financeira, separada de `operacao`, que
-- guarda o que o banco disse.
--
-- ⚠️ `COME_COTAS` (fundos) é IMPOSTO, não resgate: o governo leva cotas, o
-- investidor não recebe nada. Entra como classe 'imposto'.
--
-- ⚠️ NÃO SOMAR proventos ao aportado. DIVIDENDOS/JCP/ALUGUEIS/PAGAMENTO_JUROS
-- são dinheiro que SAIU do ativo pro bolso — se virassem aporte, cada dividendo
-- pioraria a rentabilidade exibida.
--
-- Guardamos o BRUTO e o LÍQUIDO: o doc dá os dois, mais IR e IOF por
-- movimentação, e é a única forma de mostrar "resgatei R$ 1.000, caiu R$ 950".
--
-- Idempotente.
-- =====================================================================

create table if not exists public.investimento_movimentos (
  id               uuid primary key default gen_random_uuid(),
  grupo_id         uuid not null,
  investimento_id  uuid not null references public.investimentos(id) on delete cascade,

  -- Id da movimentação na Celcoin. É a chave de deduplicação: o sync roda todo
  -- dia e relê a mesma janela.
  of_mov_id        text not null,

  data             date not null,
  -- ENTRADA | SAIDA, como o banco manda (`type`).
  direcao          text,
  -- O que o banco disse: APLICACAO, RESGATE, DIVIDENDOS, COME_COTAS, …
  operacao         text,
  -- COMO A SORA LÊ: aporte | resgate | provento | imposto | neutro.
  -- É esta coluna que os totais usam — `operacao` fica pra exibir.
  classe           text not null default 'neutro',

  valor            numeric not null default 0,   -- líquido (o que caiu/saiu)
  valor_bruto      numeric,
  ir               numeric,
  iof              numeric,
  quantidade       numeric,
  preco_unitario   numeric,

  created_at       timestamptz default now(),

  unique (investimento_id, of_mov_id)
);

create index if not exists idx_inv_mov_grupo_data
  on public.investimento_movimentos (grupo_id, data desc);
create index if not exists idx_inv_mov_investimento
  on public.investimento_movimentos (investimento_id);
-- Os totais da tela filtram por classe dentro do grupo.
create index if not exists idx_inv_mov_classe
  on public.investimento_movimentos (grupo_id, classe, data desc);

comment on column public.investimento_movimentos.classe is
  'Leitura financeira: aporte | resgate | provento | imposto | neutro. TRANSFERENCIA_* é neutro — o papel muda de corretora, o dinheiro não se move.';

-- ── Conferência (rodar solto, depois de um sync) ──────────────────────
-- select classe, operacao, count(*), sum(valor)
--   from public.investimento_movimentos group by 1,2 order by 1,3 desc;
