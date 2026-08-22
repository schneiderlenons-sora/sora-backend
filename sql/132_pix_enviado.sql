-- =============================================================================
-- 132 — categoria "Pix enviado" (DESPESA) + reclassificação do histórico
--
-- PROBLEMA: o categorizador manda "Pix enviado" e "Pix recebido" para a MESMA
-- categoria `PIX`, que na taxonomia é de RECEITA. Resultado: todo Pix que SAI
-- fica com categoria de entrada.
--
-- O dinheiro nunca sumiu — Transações e Relatórios somam por `tipo`, então o
-- Pix enviado sempre contou como despesa lá. Quem escondia era a aba
-- CATEGORIAS, que lista as categorias de despesa e não encontrava `PIX` entre
-- elas. Medido numa conta real: R$ 603,09 invisíveis num mês só, e o usuário
-- perguntando por que o total da aba não batia com o das outras.
--
-- ⚠️ NÃO É CASO ISOLADO. `PIX` é de receita nos 141 grupos da base, e há
-- 1.106 lançamentos de Gasto com essa categoria (contra 467 Recebimentos, que
-- estão corretos). Atinge todo mundo que conecta banco pelo Open Finance.
--
-- ── POR QUE UMA CATEGORIA NOVA, E NÃO "Financeiro" OU "Outros" ──────────────
-- Jogar em `Financeiro` misturaria Pix com tarifa bancária e juros; em `Outros`
-- perderia a informação. `Pix enviado` espelha `PIX` do lado da despesa, mantém
-- o lançamento distinguível e deixa o usuário reclassificar em lote depois se
-- quiser. Mesmo ícone (⚡) e cor do irmão de receita.
--
-- ⚠️ A RECLASSIFICAÇÃO É ESTREITA: só `tipo = 'Gasto'` E `categoria = 'PIX'`.
-- Recebimento com PIX fica intocado — aquele está certo. E o sync NUNCA
-- reescreve linha existente (é o que protege a categoria corrigida à mão), por
-- isso o histórico precisa ser tratado aqui.
--
-- Idempotente. Rodar no Supabase → SQL Editor.
-- =============================================================================

-- 1. Cria a categoria em TODOS os grupos que ainda não a têm, pendurada em
--    "Financeiro" (a raiz de despesa que existe nos 141 grupos).
insert into public.categorias (grupo_id, nome, tipo, parent_id, icone, cor, ativa)
select f.grupo_id, 'Pix enviado', 'despesa', f.id, '⚡', '#808080', true
  from public.categorias f
 where f.nome = 'Financeiro'
   and f.parent_id is null
   and not exists (
     select 1 from public.categorias x
      where x.grupo_id = f.grupo_id and x.nome = 'Pix enviado'
   );

-- 2. Reclassifica o histórico. SÓ saída — entrada continua em `PIX`.
update public.transacoes
   set categoria = 'Pix enviado'
 where tipo = 'Gasto'
   and categoria = 'PIX';

-- =============================================================================
-- Verificação:
--   -- deve dar 0 (nenhuma saída sobrou na categoria de receita):
--   select count(*) from public.transacoes where tipo = 'Gasto' and categoria = 'PIX';
--
--   -- deve continuar com as entradas, intactas:
--   select count(*) from public.transacoes where tipo = 'Recebimento' and categoria = 'PIX';
--
--   -- a categoria nova existe em todos os grupos:
--   select count(*) from public.categorias where nome = 'Pix enviado';
--
-- ⚠️ Depois desta migration a aba Categorias passa a mostrar MAIS gasto do que
-- antes — não é gasto novo, é gasto que estava invisível ali. O total de
-- Transações e Relatórios não muda: eles já contavam.
-- =============================================================================
