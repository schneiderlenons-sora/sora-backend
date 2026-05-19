-- =====================================================================
-- 012 — Sora Grow (segundo painel: habitos, tarefas, projetos, humor, casa)
-- Idempotente.
-- =====================================================================

-- Plano e painel ativo do usuario
alter table public.users add column if not exists plano_grow text default 'sem_acesso'
  check (plano_grow in ('sem_acesso','trial','grow_basico','grow_premium'));
alter table public.users add column if not exists grow_trial_inicio timestamptz;
alter table public.users add column if not exists grow_trial_fim    timestamptz;
alter table public.users add column if not exists painel_ativo text default 'finance'
  check (painel_ativo in ('finance','grow'));

-- ── HABITOS ─────────────────────────────────────────────────────────
create table if not exists public.habitos (
  id               uuid primary key default gen_random_uuid(),
  grupo_id         uuid not null references public.grupos(id) on delete cascade,
  nome             text not null,
  descricao        text,
  icone            text default '🎯',
  cor              text default '#7c3aed',
  frequencia       text default 'diario' check (frequencia in ('diario','semanal','mensal')),
  dias_semana      int[] default '{1,2,3,4,5,6,7}',
  horario_lembrete time,
  ativo            boolean default true,
  created_at       timestamptz default now()
);

create table if not exists public.registros_habito (
  id         uuid primary key default gen_random_uuid(),
  habito_id  uuid not null references public.habitos(id) on delete cascade,
  grupo_id   uuid not null references public.grupos(id) on delete cascade,
  data       date not null default current_date,
  concluido  boolean default true,
  nota       text,
  created_at timestamptz default now(),
  unique(habito_id, data)
);

-- ── PROJETOS / TAREFAS ──────────────────────────────────────────────
create table if not exists public.projetos (
  id          uuid primary key default gen_random_uuid(),
  grupo_id    uuid not null references public.grupos(id) on delete cascade,
  nome        text not null,
  descricao   text,
  cor         text default '#7c3aed',
  icone       text default '📋',
  status      text default 'ativo' check (status in ('ativo','pausado','concluido')),
  data_prazo  timestamptz,
  created_at  timestamptz default now()
);

create table if not exists public.tarefas (
  id                     uuid primary key default gen_random_uuid(),
  grupo_id               uuid not null references public.grupos(id) on delete cascade,
  titulo                 text not null,
  descricao              text,
  concluida              boolean default false,
  prioridade             text default 'media' check (prioridade in ('baixa','media','alta','urgente')),
  data_vencimento        timestamptz,
  recorrente             boolean default false,
  frequencia_recorrencia text,
  projeto_id             uuid references public.projetos(id) on delete set null,
  tags                   text[],
  status_kanban          text default 'a_fazer' check (status_kanban in ('a_fazer','em_progresso','concluida')),
  criado_por             uuid references public.users(id) on delete set null,
  created_at             timestamptz default now(),
  updated_at             timestamptz default now()
);

-- ── HUMOR / BEM-ESTAR ───────────────────────────────────────────────
create table if not exists public.registros_humor (
  id         uuid primary key default gen_random_uuid(),
  grupo_id   uuid not null references public.grupos(id) on delete cascade,
  user_id    uuid references public.users(id) on delete set null,
  data       date not null default current_date,
  humor      int not null check (humor between 1 and 5),
  nota       text,
  gratidao   text[],
  energia    int check (energia between 1 and 5),
  sono_horas numeric(4,1),
  created_at timestamptz default now(),
  unique(grupo_id, user_id, data)
);

-- ── ROTINAS (manha/noite/personalizada) ─────────────────────────────
create table if not exists public.rotinas (
  id         uuid primary key default gen_random_uuid(),
  grupo_id   uuid not null references public.grupos(id) on delete cascade,
  nome       text not null,
  tipo       text default 'manha' check (tipo in ('manha','noite','personalizada')),
  horario    time,
  ativa      boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.itens_rotina (
  id              uuid primary key default gen_random_uuid(),
  rotina_id       uuid not null references public.rotinas(id) on delete cascade,
  titulo          text not null,
  duracao_minutos int default 5,
  ordem           int default 0,
  concluido_hoje  boolean default false
);

-- ── LISTA DE COMPRAS ────────────────────────────────────────────────
create table if not exists public.listas_compras (
  id         uuid primary key default gen_random_uuid(),
  grupo_id   uuid not null references public.grupos(id) on delete cascade,
  nome       text default 'Lista de compras',
  ativa      boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.itens_lista_compras (
  id              uuid primary key default gen_random_uuid(),
  lista_id        uuid not null references public.listas_compras(id) on delete cascade,
  nome            text not null,
  quantidade      text default '1',
  unidade         text,
  categoria       text,
  comprado        boolean default false,
  preco_estimado  numeric(10,2),
  created_at      timestamptz default now()
);

-- ── INDEXES ─────────────────────────────────────────────────────────
create index if not exists idx_habitos_grupo         on public.habitos(grupo_id) where ativo = true;
create index if not exists idx_registros_habito      on public.registros_habito(habito_id, data desc);
create index if not exists idx_tarefas_grupo         on public.tarefas(grupo_id, concluida, prioridade);
create index if not exists idx_tarefas_projeto       on public.tarefas(projeto_id) where projeto_id is not null;
create index if not exists idx_humor_grupo_data      on public.registros_humor(grupo_id, data desc);
create index if not exists idx_itens_lista           on public.itens_lista_compras(lista_id, comprado);

-- ── RLS + politicas para service_role ───────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['habitos','registros_habito','tarefas','projetos','registros_humor','rotinas','itens_rotina','listas_compras','itens_lista_compras']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "service_role_all_%s" on public.%I', t, t);
    execute format('create policy "service_role_all_%s" on public.%I for all to service_role using (true) with check (true)', t, t);
  end loop;
end $$;
