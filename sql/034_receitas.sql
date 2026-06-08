-- =====================================================================
-- 034 — Receitas + loop "cozinhar" com a lista de compras
--
-- O usuário cadastra receitas com ingredientes. Ao "cozinhar" uma receita,
-- a Sora cruza os ingredientes com a despensa: o que está marcado como
-- 'tem' é ignorado, o que falta (ou não existe na despensa) vai direto pra
-- lista de compras — fechando o mesmo loop da despensa.
--
-- "o que posso cozinhar?" no WhatsApp lista as receitas cujos ingredientes
-- você já tem em casa.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

create table if not exists public.receitas (
  id           uuid primary key default gen_random_uuid(),
  grupo_id     uuid not null references public.grupos(id) on delete cascade,
  nome         text not null,
  icone        text default '🍳',
  porcoes      int,                 -- rende quantas porções
  tempo_min    int,                 -- tempo de preparo em minutos
  modo_preparo text,                -- passo a passo (texto livre)
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);

create index if not exists idx_receitas_grupo on public.receitas(grupo_id);

create table if not exists public.receita_ingredientes (
  id          uuid primary key default gen_random_uuid(),
  receita_id  uuid not null references public.receitas(id) on delete cascade,
  nome        text not null,
  quantidade  text,                 -- ex.: "2 xíc.", "500g", "a gosto"
  categoria   text,                 -- pra cair na seção certa da lista de compras
  ordem       int default 0,
  created_at  timestamptz default now()
);

create index if not exists idx_receita_ing_receita on public.receita_ingredientes(receita_id);
