-- =====================================================================
-- 072 — Categorias v2: novas predefinidas + subcategorias de Saúde + fixes
--
-- CONVENÇÃO (importante): `nome` vai SEM emoji e `icone` leva o emoji.
-- As migrations antigas gravaram '💪 Academia' + icone '💪' → o painel mostrava
-- o emoji DUAS vezes. Aqui isso é corrigido (nome limpo) e as novas seguem a
-- convenção certa.
--
-- O QUE FAZ:
--   1. Helpers: criar_categoria_pai (com ícone/tipo) e criar_subcategoria_icone.
--   2. Redefine criar_categorias_extra (canônica da 030/067) mantendo TUDO que
--      já fazia + as categorias novas:
--        Autocuidado 🧼 · Vendas 💵 (receita) · Presente 🎁 · Combustível ⛽
--        Seguro 🔒 · Filhos 👶 · Financiamento 🔖 · Extras 📥 (receita)
--      e as subcategorias de Saúde: Médico 🩺 · Plano de Saúde ❤️‍🩹
--   3. Fixes nos grupos existentes: emoji duplicado (Academia/Encomendas),
--      ícone da Escola (📦 → 🏫) e do Autocuidado (→ 🧼).
--   4. Backfill em todos os grupos.
--
-- Idempotente (só cria o que não existe). Aplicar: Supabase → SQL Editor → Run.
-- =====================================================================

-- ── Helper: categoria PAI com ícone + tipo ───────────────────────────
-- p_match: padrão ilike pra achar uma já existente (default '%nome%') — pega
-- também as legadas com emoji no nome ('💪 Academia').
create or replace function public.criar_categoria_pai(
  p_grupo_id uuid,
  p_nome     text,
  p_icone    text,
  p_tipo     text default 'despesa',
  p_match    text default null
)
returns uuid
language plpgsql
as $$
declare
  v_id    uuid;
  v_match text := coalesce(p_match, '%' || p_nome || '%');
begin
  select id into v_id
    from public.categorias
   where grupo_id = p_grupo_id
     and parent_id is null
     and nome ilike v_match
     and coalesce(ativa, true) = true
   limit 1;

  if v_id is null then
    insert into public.categorias (grupo_id, nome, parent_id, icone, cor, tipo, ativa)
    values (p_grupo_id, p_nome, null, p_icone, '#808080', p_tipo, true)
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

-- ── Helper: subcategoria com ícone (a criar_subcategoria antiga fixa '📦') ──
create or replace function public.criar_subcategoria_icone(
  p_grupo_id uuid,
  p_parent   uuid,
  p_nome     text,
  p_icone    text
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
  values (p_grupo_id, p_nome, p_parent, p_icone, '#808080', 'despesa', true);
end;
$$;

-- ── Canônica: tudo da 030/067 + o que a 072 traz ─────────────────────
create or replace function public.criar_categorias_extra(p_grupo_id uuid)
returns void
language plpgsql
as $$
declare
  v_enc    uuid;
  v_alim   uuid;
  v_transp uuid;
  v_vest   uuid;
  v_saude  uuid;
begin
  -- ── Encomendas + marketplaces (da 030) ──
  v_enc := public.criar_categoria_pai(p_grupo_id, 'Encomendas', '📦', 'despesa', '%encomendas%');
  perform public.criar_subcategoria(p_grupo_id, v_enc, 'Shopee');
  perform public.criar_subcategoria(p_grupo_id, v_enc, 'Mercado Livre');
  perform public.criar_subcategoria(p_grupo_id, v_enc, 'Amazon');
  perform public.criar_subcategoria(p_grupo_id, v_enc, 'Aliexpress');
  perform public.criar_subcategoria(p_grupo_id, v_enc, 'TikTok Shop');

  -- ── iFood em Alimentação (da 030) ──
  select id into v_alim
    from public.categorias
   where grupo_id = p_grupo_id and parent_id is null
     and nome ilike '%aliment%' and coalesce(ativa, true) = true
   limit 1;
  perform public.criar_subcategoria(p_grupo_id, v_alim, 'iFood');

  -- ── Uber em Transporte (da 030) ──
  select id into v_transp
    from public.categorias
   where grupo_id = p_grupo_id and parent_id is null
     and nome ilike '%transport%' and coalesce(ativa, true) = true
   limit 1;
  perform public.criar_subcategoria(p_grupo_id, v_transp, 'Uber');

  -- ── Nike / Shein / Adidas em Vestuário (da 030) ──
  select id into v_vest
    from public.categorias
   where grupo_id = p_grupo_id and parent_id is null
     and nome ilike '%vestu%' and coalesce(ativa, true) = true
   limit 1;
  perform public.criar_subcategoria(p_grupo_id, v_vest, 'Nike');
  perform public.criar_subcategoria(p_grupo_id, v_vest, 'Shein');
  perform public.criar_subcategoria(p_grupo_id, v_vest, 'Adidas');

  -- ── Academia (da 067) — agora com nome LIMPO ──
  perform public.criar_categoria_pai(p_grupo_id, 'Academia', '💪', 'despesa', '%academia%');

  -- ── NOVAS categorias pai (072) ──
  perform public.criar_categoria_pai(p_grupo_id, 'Autocuidado',   '🧼', 'despesa');
  perform public.criar_categoria_pai(p_grupo_id, 'Presente',      '🎁', 'despesa');
  perform public.criar_categoria_pai(p_grupo_id, 'Combustível',   '⛽', 'despesa', '%combust%');
  perform public.criar_categoria_pai(p_grupo_id, 'Seguro',        '🔒', 'despesa', '%seguro%');
  perform public.criar_categoria_pai(p_grupo_id, 'Filhos',        '👶', 'despesa');
  perform public.criar_categoria_pai(p_grupo_id, 'Financiamento', '🔖', 'despesa', '%financiamento%');
  -- Entradas (tipo=receita → aparecem ao registrar uma receita)
  perform public.criar_categoria_pai(p_grupo_id, 'Vendas',        '💵', 'receita', '%vendas%');
  perform public.criar_categoria_pai(p_grupo_id, 'Extras',        '📥', 'receita', '%extras%');

  -- ── NOVAS subcategorias de Saúde (072) ──
  -- '%sa_de%': em LIKE o `_` casa 1 caractere qualquer → pega "Saúde" E "Saude".
  -- (NÃO usar '[uú]' aqui: ILIKE não tem classe de caractere, viraria texto literal.)
  v_saude := public.criar_categoria_pai(p_grupo_id, 'Saúde', '💊', 'despesa', '%sa_de%');
  perform public.criar_subcategoria_icone(p_grupo_id, v_saude, 'Médico', '🩺');
  perform public.criar_subcategoria_icone(p_grupo_id, v_saude, 'Plano de Saúde', '❤️‍🩹');
end;
$$;

-- ── FIXES nos grupos existentes ──────────────────────────────────────
-- 1) Emoji duplicado: o nome NÃO deve carregar emoji (convenção nome+icone).
update public.categorias set nome = 'Academia'
 where parent_id is null and btrim(nome) = '💪 Academia';
update public.categorias set nome = 'Encomendas'
 where parent_id is null and btrim(nome) = '📦 Encomendas';

-- 2) Escola: ícone genérico 📦 → 🏫
update public.categorias set icone = '🏫'
 where parent_id is null and nome ilike '%escola%';

-- 3) Autocuidado: garante o 🧼 (quem já tinha ficou com ícone aleatório)
update public.categorias set icone = '🧼'
 where parent_id is null and nome ilike '%autocuidado%';

-- ── Backfill: aplica a todos os grupos já existentes ─────────────────
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
--   select nome, icone, tipo from public.categorias
--    where grupo_id = '<seu_grupo>' and parent_id is null order by nome;
--   -- Academia|💪  Autocuidado|🧼  Combustível|⛽  Escola|🏫  Extras|📥(receita)
--   -- Filhos|👶  Financiamento|🔖  Presente|🎁  Seguro|🔒  Vendas|💵(receita)
--
--   select c.nome, c.icone from public.categorias c
--     join public.categorias p on p.id = c.parent_id
--    where c.grupo_id = '<seu_grupo>' and p.nome ilike '%saude%';
--   -- Médico|🩺   Plano de Saúde|❤️‍🩹
-- =====================================================================
