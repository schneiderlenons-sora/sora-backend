-- =====================================================================
-- 079 — Seção Bíblia (Estudos do Grow) · MVP por REFERÊNCIA
--
-- Duas tabelas dedicadas (NÃO reusa sessoes_estudo — o tipo lá tem CHECK e as
-- sessões pertencem a cursos). A leitura bíblica entra no heatmap/streak de
-- Estudos por MERGE no frontend (some os minutos), mas como linha própria.
--
-- Conteúdo (planos + versículos) é estático no código (lib/biblia.ts) — aqui só
-- o ESTADO do usuário: plano ativo + leituras registradas.
-- Padrão grupo_id + user_id igual às demais tabelas do Grow.
-- Idempotente. Aplicar: Supabase → SQL Editor → Run.
-- =====================================================================

-- Plano ativo do usuário (1 por usuário).
create table if not exists public.biblia_progresso (
  id          uuid primary key default gen_random_uuid(),
  grupo_id    uuid not null references public.grupos(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  plano_id    text not null,
  iniciado_em date not null default current_date,
  atualizado_em timestamptz default now(),
  unique (grupo_id, user_id)
);

-- Leituras registradas. `dia`/`plano_id` preenchidos quando é a leitura de um
-- dia do plano; nulos quando é uma reflexão avulsa. `duracao_min` alimenta o
-- heatmap de Estudos.
create table if not exists public.biblia_leituras (
  id          uuid primary key default gen_random_uuid(),
  grupo_id    uuid not null references public.grupos(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  data        date not null default current_date,
  plano_id    text,
  dia         int,
  referencia  text not null,
  duracao_min int not null default 0 check (duracao_min >= 0 and duracao_min <= 1440),
  reflexao    text,
  created_at  timestamptz default now()
);

-- Um dia de um plano só pode ser concluído UMA vez por usuário (evita duplicar
-- progresso). Reflexões avulsas (dia null) não entram na trava.
create unique index if not exists uq_biblia_dia_plano
  on public.biblia_leituras (user_id, plano_id, dia)
  where dia is not null;

create index if not exists idx_biblia_leituras_user_data
  on public.biblia_leituras (user_id, data desc);

-- =====================================================================
-- Verificação:
--   select * from public.biblia_progresso;
--   select data, plano_id, dia, referencia, duracao_min from public.biblia_leituras order by data desc;
-- =====================================================================
