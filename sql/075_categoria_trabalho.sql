-- =====================================================================
-- 075 — Categoria predefinida "💼 Trabalho/Negócio"
--
-- Gastos de trabalho/negócio (anúncios: Facebook/Meta/Google Ads, ferramentas).
-- Reusa criar_categoria_pai (da 072). Backfill em todos os grupos existentes.
-- Idempotente. Aplicar: Supabase → SQL Editor → Run.
--
-- Obs.: novos cadastros passam a receber via a linha adicionada em
-- criar_categorias_extra (072). Se ainda não atualizou aquela função, rode este
-- backfill que cobre quem já existe.
-- =====================================================================

do $$
declare g record;
begin
  for g in select id from public.grupos loop
    perform public.criar_categoria_pai(g.id, 'Trabalho/Negócio', '💼', 'despesa', '%trabalho%');
  end loop;
end $$;

-- =====================================================================
-- Verificação:
--   select nome, icone from public.categorias
--    where parent_id is null and nome ilike '%trabalho%';
--   -- Trabalho/Negócio | 💼
-- =====================================================================
