-- =====================================================================
-- 014 — Sora Grow: aba Estudos
-- 6 tabelas: cursos, disciplinas, provas, sessoes_estudo, metas, anotacoes
-- Idempotente.
-- =====================================================================

-- ── CURSOS (faculdade, online, concurso, idioma, outro) ────────────
create table if not exists public.cursos (
  id              uuid primary key default gen_random_uuid(),
  grupo_id        uuid not null references public.grupos(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  nome            text not null,
  tipo            text default 'online' check (tipo in ('faculdade','online','concurso','idioma','outro')),
  instituicao     text,
  instrutor       text,
  cor             text default '#7c3aed',
  icone           text default '🎓',
  data_inicio     date,
  data_fim        date,
  carga_horaria_h int,
  progresso_pct   numeric(5,2) default 0 check (progresso_pct between 0 and 100),
  url             text,
  observacao      text,
  status          text default 'ativo' check (status in ('ativo','concluido','pausado','abandonado')),
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ── DISCIPLINAS / MATÉRIAS ─────────────────────────────────────────
create table if not exists public.disciplinas (
  id                  uuid primary key default gen_random_uuid(),
  grupo_id            uuid not null references public.grupos(id) on delete cascade,
  user_id             uuid not null references public.users(id) on delete cascade,
  curso_id            uuid references public.cursos(id) on delete set null,
  nome                text not null,
  cor                 text default '#7c3aed',
  icone               text default '📚',
  prioridade          int default 3 check (prioridade between 1 and 5),
  meta_minutos_semana int,
  status              text default 'ativa' check (status in ('ativa','concluida','pausada')),
  observacao          text,
  created_at          timestamptz default now()
);

-- ── PROVAS / AVALIAÇÕES ────────────────────────────────────────────
create table if not exists public.provas (
  id            uuid primary key default gen_random_uuid(),
  grupo_id      uuid not null references public.grupos(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  disciplina_id uuid references public.disciplinas(id) on delete set null,
  curso_id      uuid references public.cursos(id) on delete set null,
  tipo          text default 'prova' check (tipo in ('prova','trabalho','simulado','projeto','tcc','redacao','outra')),
  titulo        text not null,
  data          date not null,
  hora          time,
  peso          numeric(5,2),
  nota_obtida   numeric(6,2),
  nota_maxima   numeric(6,2) default 10,
  observacao    text,
  realizada     boolean default false,
  created_at    timestamptz default now()
);

-- ── SESSÕES DE ESTUDO (cerne do streak/heatmap) ────────────────────
create table if not exists public.sessoes_estudo (
  id            uuid primary key default gen_random_uuid(),
  grupo_id      uuid not null references public.grupos(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  disciplina_id uuid references public.disciplinas(id) on delete set null,
  curso_id      uuid references public.cursos(id) on delete set null,
  data          date not null default current_date,
  hora_inicio   time,
  hora_fim      time,
  duracao_min   int  not null check (duracao_min > 0 and duracao_min <= 1440),
  tipo          text default 'estudo' check (tipo in ('estudo','revisao','exercicios','leitura','video','aula','simulado','projeto')),
  tema          text,
  observacao    text,
  produtividade int check (produtividade between 1 and 5),
  created_at    timestamptz default now()
);

-- ── METAS DE ESTUDO ────────────────────────────────────────────────
create table if not exists public.metas_estudo (
  id                  uuid primary key default gen_random_uuid(),
  grupo_id            uuid not null references public.grupos(id) on delete cascade,
  user_id             uuid not null references public.users(id) on delete cascade,
  meta_minutos_diaria   int,
  meta_minutos_semanal  int,
  meta_sessoes_semanal  int,
  curso_id            uuid references public.cursos(id) on delete cascade,
  updated_at          timestamptz default now(),
  unique(grupo_id, user_id, curso_id)
);

-- ── ANOTAÇÕES ──────────────────────────────────────────────────────
create table if not exists public.anotacoes_estudo (
  id            uuid primary key default gen_random_uuid(),
  grupo_id      uuid not null references public.grupos(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  disciplina_id uuid references public.disciplinas(id) on delete set null,
  curso_id      uuid references public.cursos(id) on delete set null,
  titulo        text,
  conteudo      text,
  tags          text[],
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ── INDEXES ────────────────────────────────────────────────────────
create index if not exists idx_cursos_user_status        on public.cursos(user_id, status);
create index if not exists idx_disciplinas_user_curso    on public.disciplinas(user_id, curso_id);
create index if not exists idx_provas_user_data          on public.provas(user_id, data) where realizada = false;
create index if not exists idx_provas_disciplina_data    on public.provas(disciplina_id, data desc);
create index if not exists idx_sessoes_user_data         on public.sessoes_estudo(user_id, data desc);
create index if not exists idx_sessoes_disciplina        on public.sessoes_estudo(disciplina_id, data desc);
create index if not exists idx_sessoes_curso             on public.sessoes_estudo(curso_id, data desc);
create index if not exists idx_anotacoes_disciplina      on public.anotacoes_estudo(disciplina_id, created_at desc);

-- ── RLS + politicas service_role ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['cursos','disciplinas','provas','sessoes_estudo','metas_estudo','anotacoes_estudo']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "service_role_all_%s" on public.%I', t, t);
    execute format('create policy "service_role_all_%s" on public.%I for all to service_role using (true) with check (true)', t, t);
  end loop;
end $$;
