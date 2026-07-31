-- =====================================================================
-- 108 — DRE gerencial (Sora Negócios, fase 4)
--
-- O DRE deixa de ser um resumo de caixa e passa a responder as perguntas que
-- decidem preço: quanto sobra de cada real vendido (margem bruta), quanto a
-- loja custa parada (despesa fixa) e quanto precisa faturar pra empatar
-- (ponto de equilíbrio).
--
-- DUAS COISAS QUE O SCHEMA PRECISA GUARDAR E ANTES NÃO GUARDAVA:
--
-- 1. NATUREZA DA DESPESA (fixa × variável). Sem essa separação o ponto de
--    equilíbrio é impossível de calcular. O padrão vem de um mapa no código
--    (services/dre.js) — a coluna existe só pro caso em que o dono discorda
--    ("meu aluguel é sazonal, pra mim é variável"). Nula = usa o mapa.
--
-- 2. AS LINHAS NOVAS DO SNAPSHOT (CMV, lucro bruto, despesas por natureza,
--    ponto de equilíbrio). Ficam materializadas porque o histórico e a
--    previsão leem o snapshot, não recalculam.
--
-- Nada aqui reescreve dado existente: colunas nascem nulas/zeradas e o próximo
-- "Atualizar" do DRE preenche.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

-- ── 1. Natureza da despesa (override do mapa) ────────────────────────
alter table public.lancamentos_negocio
  add column if not exists natureza text;

do $$ begin
  alter table public.lancamentos_negocio
    add constraint lancamentos_negocio_natureza_check
    check (natureza in ('fixa','variavel') or natureza is null);
exception when duplicate_object then null; end $$;

alter table public.custos_negocio
  add column if not exists natureza text;

do $$ begin
  alter table public.custos_negocio
    add constraint custos_negocio_natureza_check
    check (natureza in ('fixa','variavel') or natureza is null);
exception when duplicate_object then null; end $$;

-- ── 2. Linhas novas do DRE ───────────────────────────────────────────
alter table public.dre_snapshots
  -- Custo da mercadoria vendida: vem do custo CONGELADO em venda_itens, não do
  -- custo atual do produto (reprecificar não pode reescrever a margem de ontem).
  add column if not exists cmv                   integer not null default 0,
  add column if not exists lucro_bruto           integer not null default 0,
  add column if not exists margem_bruta_pct      numeric(6,2) not null default 0,
  add column if not exists despesas_fixas        integer not null default 0,
  add column if not exists despesas_variaveis    integer not null default 0,
  add column if not exists resultado_operacional integer not null default 0,
  add column if not exists margem_contribuicao   integer not null default 0,
  -- Faturamento necessário pra o resultado ser zero. NULL de propósito quando
  -- não há receita no mês ou a margem de contribuição é negativa: zero ali
  -- diria "você já empatou", que é o oposto da verdade.
  add column if not exists ponto_equilibrio      integer,
  -- Informativo: compra de estoque NÃO é despesa do mês (vira CMV quando
  -- vender). Guardado pra tela poder explicar a diferença entre o caixa e o
  -- resultado — é a pergunta nº 1 de quem abastece a loja.
  add column if not exists compras_estoque       integer not null default 0;

-- Índice do histórico (a tela do DRE e a previsão leem 6–12 meses por empresa).
create index if not exists idx_dre_empresa_periodo
  on public.dre_snapshots(empresa_id, periodo desc);
