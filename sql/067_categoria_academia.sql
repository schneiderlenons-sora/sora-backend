-- =====================================================================
-- 067 — Categoria predefinida "💪 Academia" para TODOS os grupos
--
-- Adiciona a categoria pai "💪 Academia" (despesa, ícone 💪):
--   • novos usuários → via criar_categorias_extra (chamada pelo trigger de signup)
--   • grupos existentes → via backfill no fim
--
-- Redefine criar_categorias_extra (canônica da 030) mantendo TUDO que ela já
-- fazia + o bloco novo da Academia. Idempotente (só cria se não existir).
-- Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

create or replace function public.criar_categorias_extra(p_grupo_id uuid)
returns void
language plpgsql
as $$
declare
  v_enc    uuid;
  v_alim   uuid;
  v_transp uuid;
  v_vest   uuid;
begin
  -- ── Encomendas (categoria pai — cria se não existir) ──
  select id into v_enc
    from public.categorias
   where grupo_id = p_grupo_id
     and parent_id is null
     and nome ilike '%encomendas%'
     and coalesce(ativa, true) = true
   limit 1;

  if v_enc is null then
    insert into public.categorias (grupo_id, nome, parent_id, icone, cor, tipo, ativa)
    values (p_grupo_id, '📦 Encomendas', null, '📦', '#808080', 'despesa', true)
    returning id into v_enc;
  end if;

  perform public.criar_subcategoria(p_grupo_id, v_enc, 'Shopee');
  perform public.criar_subcategoria(p_grupo_id, v_enc, 'Mercado Livre');
  perform public.criar_subcategoria(p_grupo_id, v_enc, 'Amazon');
  perform public.criar_subcategoria(p_grupo_id, v_enc, 'Aliexpress');
  perform public.criar_subcategoria(p_grupo_id, v_enc, 'TikTok Shop');

  -- ── iFood em Alimentação ──
  select id into v_alim
    from public.categorias
   where grupo_id = p_grupo_id and parent_id is null
     and nome ilike '%aliment%' and coalesce(ativa, true) = true
   limit 1;
  perform public.criar_subcategoria(p_grupo_id, v_alim, 'iFood');

  -- ── Uber em Transporte ──
  select id into v_transp
    from public.categorias
   where grupo_id = p_grupo_id and parent_id is null
     and nome ilike '%transport%' and coalesce(ativa, true) = true
   limit 1;
  perform public.criar_subcategoria(p_grupo_id, v_transp, 'Uber');

  -- ── Nike / Shein / Adidas em Vestuário ──
  select id into v_vest
    from public.categorias
   where grupo_id = p_grupo_id and parent_id is null
     and nome ilike '%vestu%' and coalesce(ativa, true) = true
   limit 1;
  perform public.criar_subcategoria(p_grupo_id, v_vest, 'Nike');
  perform public.criar_subcategoria(p_grupo_id, v_vest, 'Shein');
  perform public.criar_subcategoria(p_grupo_id, v_vest, 'Adidas');

  -- ── Academia (NOVA — categoria pai, cria se não existir) ──
  if not exists (
    select 1 from public.categorias
     where grupo_id = p_grupo_id and parent_id is null
       and nome ilike '%academia%' and coalesce(ativa, true) = true
  ) then
    insert into public.categorias (grupo_id, nome, parent_id, icone, cor, tipo, ativa)
    values (p_grupo_id, '💪 Academia', null, '💪', '#808080', 'despesa', true);
  end if;
end;
$$;

-- Backfill — aplica a todos os grupos já existentes.
do $$
declare g record;
begin
  for g in select id from public.grupos loop
    perform public.criar_categorias_extra(g.id);
  end loop;
end;
$$;

-- =====================================================================
-- Verificação:
--   select nome, icone from public.categorias
--    where grupo_id = '<seu_grupo>' and parent_id is null and nome ilike '%academia%';
--   -- deve retornar: 💪 Academia | 💪
-- =====================================================================
