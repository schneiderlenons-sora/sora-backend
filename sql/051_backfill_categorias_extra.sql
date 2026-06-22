-- 051: re-backfill das categorias extras (Encomendas/iFood/Uber + subs
-- Nike/Shein/Adidas em Vestuário) em TODOS os grupos.
-- Necessário porque grupos criados pelo painel (/grupos/criar) chamavam só
-- criar_categorias_padrao, ficando sem as extras. A função é idempotente
-- (só insere o que falta). Requer a migration 030 (criar_categorias_extra).

do $$
declare g record;
begin
  for g in select id from public.grupos loop
    perform public.criar_categorias_extra(g.id);
  end loop;
end $$;
