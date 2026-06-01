-- =====================================================================
-- 030 — Categorias/subcategorias padrão extras
--
-- Adiciona, para TODO grupo (existentes via backfill + novos via trigger):
--   • Categoria "📦 Encomendas" com subs: Shopee, Mercado Livre, Amazon,
--     Aliexpress, TikTok Shop
--   • Subcategoria "iFood" em Alimentação
--   • Subcategoria "Uber"  em Transporte
--   • Subcategorias "Nike", "Shein", "Adidas" em Vestuário
--
-- Os nomes das subcategorias são SIMPLES (sem emoji) de propósito: o painel
-- detecta a marca pelo nome (logo oficial) e agrupa por nome normalizado.
--
-- Idempotente — pode rodar quantas vezes quiser. NÃO mexe na função
-- criar_categorias_padrao (que é mantida no Dashboard); apenas a complementa.
-- Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

-- 1. Helper: cria uma subcategoria sob um pai, se ainda não existir
--    (comparação por nome normalizado: minúsculo + sem espaços nas pontas).
create or replace function public.criar_subcategoria(
  p_grupo_id uuid,
  p_parent   uuid,
  p_nome     text
)
returns void
language plpgsql
as $$
begin
  if p_parent is null then return; end if;
  if exists (
    select 1 from public.categorias
     where grupo_id = p_grupo_id
       and parent_id = p_parent
       and lower(btrim(nome)) = lower(btrim(p_nome))
  ) then
    return;
  end if;
  insert into public.categorias (grupo_id, nome, parent_id, icone, cor, tipo, ativa)
  values (p_grupo_id, p_nome, p_parent, '📦', '#808080', 'despesa', true);
end;
$$;

-- 2. Função que adiciona as categorias/subcategorias extras a um grupo
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
end;
$$;

-- 3. Trigger de novo usuário passa a chamar também a função extra.
--    (Mesma definição da migration 028 + uma linha.)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grupo_id uuid;
  v_name     text;
begin
  v_name := coalesce(
    new.raw_user_meta_data->>'name',
    new.raw_user_meta_data->>'full_name',
    split_part(coalesce(new.email, ''), '@', 1),
    'Usuário'
  );

  insert into public.users (id, name, email, phone, plano)
  values (new.id, v_name, coalesce(new.email, ''), null, 'inativo')
  on conflict (id) do nothing;

  insert into public.grupos (nome, dono_id)
  values ('Pessoal de ' || v_name, new.id)
  returning id into v_grupo_id;

  update public.users
     set grupo_ativo = v_grupo_id
   where id = new.id;

  perform public.criar_categorias_padrao(v_grupo_id);
  perform public.criar_categorias_extra(v_grupo_id);

  return new;
end;
$$;

grant usage on schema public to supabase_auth_admin;
grant execute on function public.handle_new_user() to supabase_auth_admin;

-- 4. Backfill — aplica a todos os grupos já existentes.
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
--   select nome from public.categorias
--    where grupo_id = '<seu_grupo>' and parent_id is not null
--    order by nome;
--   -- deve listar Adidas, Aliexpress, Amazon, iFood, Mercado Livre,
--   --   Nike, Shein, Shopee, TikTok Shop, Uber (entre outras)
-- =====================================================================
