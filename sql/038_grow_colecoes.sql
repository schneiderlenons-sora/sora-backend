-- =====================================================================
-- 038 — Coleções do Sora Grow: Viagens & Lazer, Filmes/Séries/Desenhos,
-- Leituras. Tudo escopo por grupo_id (compartilhado casal/família).
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

-- ── Viagens (planejador) ──────────────────────────────────────────────
create table if not exists public.viagens (
  id           uuid primary key default gen_random_uuid(),
  grupo_id     uuid not null references public.grupos(id) on delete cascade,
  destino      text not null,
  emoji        text default '✈️',
  data_inicio  date,
  data_fim     date,
  orcamento    numeric,
  status       text default 'planejando',   -- planejando | confirmada | concluida
  notas        text,
  checklist    jsonb default '[]'::jsonb,    -- [{ "texto": "...", "feito": false }]
  cover_url    text,
  created_at   timestamptz default now()
);
create index if not exists idx_viagens_grupo on public.viagens(grupo_id);

-- ── Bucket list (sonhos / experiências) ───────────────────────────────
create table if not exists public.bucket_list (
  id          uuid primary key default gen_random_uuid(),
  grupo_id    uuid not null references public.grupos(id) on delete cascade,
  titulo      text not null,
  categoria   text default 'lugar',          -- lugar | experiencia | aventura | gastronomia
  emoji       text default '🌍',
  status      text default 'sonho',          -- sonho | planejando | feito
  notas       text,
  created_at  timestamptz default now()
);
create index if not exists idx_bucket_grupo on public.bucket_list(grupo_id);

-- ── Mídia (filmes / séries / desenhos / anime / docs) ─────────────────
create table if not exists public.midia (
  id          uuid primary key default gen_random_uuid(),
  grupo_id    uuid not null references public.grupos(id) on delete cascade,
  titulo      text not null,
  tipo        text default 'filme',          -- filme | serie | desenho | anime | doc
  status      text default 'quero',          -- quero | assistindo | visto | abandonei
  nota        numeric,                        -- 0 a 10
  cover_url   text,
  genero      text,
  ano         int,
  comentario  text,
  favorito    boolean default false,
  created_at  timestamptz default now()
);
create index if not exists idx_midia_grupo on public.midia(grupo_id);

-- ── Leituras (livros) ─────────────────────────────────────────────────
create table if not exists public.leituras (
  id            uuid primary key default gen_random_uuid(),
  grupo_id      uuid not null references public.grupos(id) on delete cascade,
  titulo        text not null,
  autor         text,
  status        text default 'quero',        -- quero | lendo | lido | abandonei
  nota          numeric,                      -- 0 a 10
  cover_url     text,
  total_paginas int,
  pagina_atual  int default 0,
  genero        text,
  comentario    text,
  favorito      boolean default false,
  created_at    timestamptz default now()
);
create index if not exists idx_leituras_grupo on public.leituras(grupo_id);
