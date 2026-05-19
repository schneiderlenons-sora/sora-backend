-- =====================================================================
-- 013 — Sora Grow: aba Saude (saude e corpo)
-- 18 tabelas: perfil + peso + agua + nutricao + treinos + checkups +
-- consultas + exames + medicamentos + medidas + fotos + sintomas + vacinas + ciclo
-- Idempotente.
-- =====================================================================

-- ── PERFIL DE SAUDE (1:1 user/grupo) ───────────────────────────────
create table if not exists public.perfil_saude (
  id                 uuid primary key default gen_random_uuid(),
  grupo_id           uuid not null references public.grupos(id) on delete cascade,
  user_id            uuid not null references public.users(id) on delete cascade,
  altura_cm          int  check (altura_cm between 30 and 250),
  sexo               text check (sexo in ('M','F','outro')),
  data_nascimento    date,
  nivel_atividade    text default 'moderado' check (nivel_atividade in ('sedentario','leve','moderado','intenso','atleta')),
  objetivo           text default 'manter'   check (objetivo in ('emagrecer','manter','ganhar_massa','definicao')),
  tipo_dieta         text default 'padrao'   check (tipo_dieta in ('padrao','low_carb','cetogenica','hipercalorica','vegetariana','vegana')),
  meta_peso_kg       numeric(5,2),
  meta_peso_data     date,
  condicoes_cronicas text[],
  alergias           text[],
  ciclo_ativo        boolean default false,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now(),
  unique(grupo_id, user_id)
);

-- ── PESOS ───────────────────────────────────────────────────────────
create table if not exists public.pesos (
  id         uuid primary key default gen_random_uuid(),
  grupo_id   uuid not null references public.grupos(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  data       date not null default current_date,
  peso_kg    numeric(5,2) not null check (peso_kg > 0 and peso_kg < 600),
  observacao text,
  created_at timestamptz default now(),
  unique(user_id, data)
);

-- ── AGUA (cada registro = um gole) ─────────────────────────────────
create table if not exists public.agua_registros (
  id         uuid primary key default gen_random_uuid(),
  grupo_id   uuid not null references public.grupos(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  data       date not null default current_date,
  ml         int  not null check (ml > 0 and ml <= 5000),
  created_at timestamptz default now()
);

-- ── METAS NUTRICIONAIS ──────────────────────────────────────────────
create table if not exists public.metas_nutricao (
  id              uuid primary key default gen_random_uuid(),
  grupo_id        uuid not null references public.grupos(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  calorias        int,
  proteinas_g     int,
  carboidratos_g  int,
  gorduras_g      int,
  agua_ml         int default 2000,
  tmb             int,   -- taxa metabolica basal
  tdee            int,   -- gasto total
  calculada_em    timestamptz default now(),
  updated_at      timestamptz default now(),
  unique(grupo_id, user_id)
);

-- ── REFEICOES ───────────────────────────────────────────────────────
create table if not exists public.refeicoes (
  id          uuid primary key default gen_random_uuid(),
  grupo_id    uuid not null references public.grupos(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  data        date not null default current_date,
  hora        time default current_time,
  tipo        text default 'lanche' check (tipo in ('cafe','almoco','lanche','jantar','ceia','pre_treino','pos_treino','outro')),
  observacao  text,
  created_at  timestamptz default now()
);

create table if not exists public.refeicao_itens (
  id              uuid primary key default gen_random_uuid(),
  refeicao_id     uuid not null references public.refeicoes(id) on delete cascade,
  nome            text not null,
  quantidade_g    numeric(8,2),
  porcao_descr    text,
  calorias        numeric(8,2),
  proteinas_g     numeric(8,2),
  carboidratos_g  numeric(8,2),
  gorduras_g      numeric(8,2),
  fonte           text default 'manual' check (fonte in ('manual','local','openfoodfacts','ia')),
  created_at      timestamptz default now()
);

-- ── TREINOS (catalog + registros) ──────────────────────────────────
create table if not exists public.treinos (
  id         uuid primary key default gen_random_uuid(),
  grupo_id   uuid not null references public.grupos(id) on delete cascade,
  nome       text not null,
  categoria  text default 'outro' check (categoria in ('forca','cardio','yoga','luta','funcional','esporte','danca','outro')),
  icone      text default '💪',
  cor        text default '#7c3aed',
  ativo      boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.treino_registros (
  id            uuid primary key default gen_random_uuid(),
  grupo_id      uuid not null references public.grupos(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  treino_id     uuid references public.treinos(id) on delete set null,
  treino_nome   text,
  data          date not null default current_date,
  hora          time,
  duracao_min   int,
  intensidade   int check (intensidade between 1 and 5),
  calorias_kcal int,
  observacao    text,
  created_at    timestamptz default now()
);

-- ── CHECKUPS DIARIOS ────────────────────────────────────────────────
create table if not exists public.checkups (
  id                uuid primary key default gen_random_uuid(),
  grupo_id          uuid not null references public.grupos(id) on delete cascade,
  user_id           uuid not null references public.users(id) on delete cascade,
  data              date not null default current_date,
  agua_bateu        boolean default false,
  atividade_fisica  boolean default false,
  dieta_ok          boolean default false,
  sono_ok           boolean default false,
  meditacao         boolean default false,
  observacao        text,
  created_at        timestamptz default now(),
  unique(user_id, data)
);

-- ── CONSULTAS ───────────────────────────────────────────────────────
create table if not exists public.consultas (
  id             uuid primary key default gen_random_uuid(),
  grupo_id       uuid not null references public.grupos(id) on delete cascade,
  user_id        uuid not null references public.users(id) on delete cascade,
  profissional   text,
  especialidade  text,
  data           date not null,
  hora           time,
  local          text,
  observacao     text,
  status         text default 'agendada' check (status in ('agendada','realizada','cancelada','remarcada')),
  retorno_data   date,
  lembrete_ativo boolean default true,
  created_at     timestamptz default now()
);

-- ── EXAMES ──────────────────────────────────────────────────────────
create table if not exists public.exames (
  id              uuid primary key default gen_random_uuid(),
  grupo_id        uuid not null references public.grupos(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  consulta_id     uuid references public.consultas(id) on delete set null,
  nome            text not null,
  valor           numeric(14,4),
  unidade         text,
  data            date not null default current_date,
  referencia_min  numeric(14,4),
  referencia_max  numeric(14,4),
  observacao      text,
  created_at      timestamptz default now()
);

-- ── MEDICAMENTOS ────────────────────────────────────────────────────
create table if not exists public.medicamentos (
  id              uuid primary key default gen_random_uuid(),
  grupo_id        uuid not null references public.grupos(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  nome            text not null,
  dosagem         text,
  horarios        time[],
  dias_semana     int[] default '{1,2,3,4,5,6,7}',
  estoque_atual   int,
  estoque_alerta  int default 5,
  data_validade   date,
  observacao      text,
  receita_url     text,
  ativo           boolean default true,
  lembrete_ativo  boolean default true,
  created_at      timestamptz default now()
);

create table if not exists public.medicamento_doses (
  id                 uuid primary key default gen_random_uuid(),
  medicamento_id     uuid not null references public.medicamentos(id) on delete cascade,
  user_id            uuid not null references public.users(id) on delete cascade,
  datetime_planejado timestamptz,
  datetime_tomado    timestamptz default now(),
  status             text default 'tomou' check (status in ('tomou','atrasou','pulou')),
  created_at         timestamptz default now()
);

-- ── MEDIDAS CORPORAIS ───────────────────────────────────────────────
create table if not exists public.medidas_corporais (
  id          uuid primary key default gen_random_uuid(),
  grupo_id    uuid not null references public.grupos(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  data        date not null default current_date,
  cintura_cm  numeric(5,2),
  quadril_cm  numeric(5,2),
  braco_cm    numeric(5,2),
  perna_cm    numeric(5,2),
  peito_cm    numeric(5,2),
  pescoco_cm  numeric(5,2),
  gordura_pct numeric(5,2),
  musculo_pct numeric(5,2),
  observacao  text,
  created_at  timestamptz default now()
);

-- ── FOTOS DE PROGRESSO ──────────────────────────────────────────────
create table if not exists public.fotos_progresso (
  id         uuid primary key default gen_random_uuid(),
  grupo_id   uuid not null references public.grupos(id) on delete cascade,
  user_id    uuid not null references public.users(id) on delete cascade,
  data       date not null default current_date,
  url        text not null,
  tipo       text default 'frente' check (tipo in ('frente','lado','costas','livre')),
  peso_kg    numeric(5,2),
  observacao text,
  created_at timestamptz default now()
);

-- ── SINTOMAS (extra) ────────────────────────────────────────────────
create table if not exists public.sintomas (
  id          uuid primary key default gen_random_uuid(),
  grupo_id    uuid not null references public.grupos(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  data        date not null default current_date,
  hora        time default current_time,
  nome        text not null,
  intensidade int check (intensidade between 1 and 5),
  tags        text[],
  observacao  text,
  created_at  timestamptz default now()
);

-- ── VACINAS (extra) ─────────────────────────────────────────────────
create table if not exists public.vacinas (
  id                 uuid primary key default gen_random_uuid(),
  grupo_id           uuid not null references public.grupos(id) on delete cascade,
  user_id            uuid not null references public.users(id) on delete cascade,
  nome               text not null,
  data_aplicacao     date not null,
  dose               text,
  proxima_dose_data  date,
  local              text,
  lote               text,
  observacao         text,
  created_at         timestamptz default now()
);

-- ── CICLO MENSTRUAL (extra, ativa via perfil_saude.ciclo_ativo) ────
create table if not exists public.ciclo_menstrual (
  id           uuid primary key default gen_random_uuid(),
  grupo_id     uuid not null references public.grupos(id) on delete cascade,
  user_id      uuid not null references public.users(id) on delete cascade,
  data_inicio  date not null,
  data_fim     date,
  duracao_dias int,
  fluxo        text check (fluxo in ('leve','moderado','intenso')),
  sintomas     text[],
  observacao   text,
  created_at   timestamptz default now()
);

-- ── INDEXES ─────────────────────────────────────────────────────────
create index if not exists idx_pesos_user_data           on public.pesos(user_id, data desc);
create index if not exists idx_agua_user_data            on public.agua_registros(user_id, data desc);
create index if not exists idx_refeicoes_user_data       on public.refeicoes(user_id, data desc);
create index if not exists idx_refeicao_itens_refeicao   on public.refeicao_itens(refeicao_id);
create index if not exists idx_treino_reg_user_data      on public.treino_registros(user_id, data desc);
create index if not exists idx_checkups_user_data        on public.checkups(user_id, data desc);
create index if not exists idx_consultas_user_data       on public.consultas(user_id, data) where status = 'agendada';
create index if not exists idx_exames_user_nome_data     on public.exames(user_id, nome, data desc);
create index if not exists idx_medicamentos_user_ativos  on public.medicamentos(user_id) where ativo = true;
create index if not exists idx_med_doses_med             on public.medicamento_doses(medicamento_id, datetime_tomado desc);
create index if not exists idx_medidas_user_data         on public.medidas_corporais(user_id, data desc);
create index if not exists idx_fotos_user_data           on public.fotos_progresso(user_id, data desc);
create index if not exists idx_sintomas_user_data        on public.sintomas(user_id, data desc);
create index if not exists idx_vacinas_user              on public.vacinas(user_id, data_aplicacao desc);
create index if not exists idx_ciclo_user                on public.ciclo_menstrual(user_id, data_inicio desc);

-- ── RLS + politicas para service_role ───────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'perfil_saude','pesos','agua_registros','metas_nutricao','refeicoes','refeicao_itens',
    'treinos','treino_registros','checkups','consultas','exames','medicamentos','medicamento_doses',
    'medidas_corporais','fotos_progresso','sintomas','vacinas','ciclo_menstrual'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "service_role_all_%s" on public.%I', t, t);
    execute format('create policy "service_role_all_%s" on public.%I for all to service_role using (true) with check (true)', t, t);
  end loop;
end $$;
