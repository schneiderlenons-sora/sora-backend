-- =====================================================================
-- 008 — Metas e objetivos (planejamento financeiro)
-- Idempotente.
-- =====================================================================

create table if not exists public.metas (
  id              uuid primary key default gen_random_uuid(),
  grupo_id        uuid not null references public.grupos(id) on delete cascade,
  criado_por      uuid references public.users(id) on delete set null,
  titulo          text not null,
  descricao       text,
  valor_objetivo  numeric(12,2) not null check (valor_objetivo > 0),
  valor_atual     numeric(12,2) not null default 0,
  data_alvo       date,
  imagem_url      text,
  cor             text default '#61D17B',
  icone           text default '🎯',
  status          text default 'ativo' check (status in ('ativo','concluido','arquivado')),
  created_at      timestamp default now(),
  updated_at      timestamp default now()
);

create table if not exists public.meta_aportes (
  id          uuid primary key default gen_random_uuid(),
  meta_id     uuid not null references public.metas(id) on delete cascade,
  user_id     uuid references public.users(id) on delete set null,
  valor       numeric(12,2) not null check (valor > 0),
  tipo        text not null check (tipo in ('aporte','resgate')),
  observacao  text,
  data        date default current_date,
  created_at  timestamp default now()
);

create index if not exists idx_metas_grupo on public.metas(grupo_id, status);
create index if not exists idx_meta_aportes_meta on public.meta_aportes(meta_id, data desc);
