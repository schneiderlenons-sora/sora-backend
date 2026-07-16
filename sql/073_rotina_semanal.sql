-- =====================================================================
-- 073 — Planejamento Semanal (rotina) do Sora Grow
--
-- Card de rotina na aba Hábitos: grade dia × horário. NÃO tem check-in — é
-- visualização/organização.
--
-- MODELO — duas naturezas de bloco na MESMA tabela:
--   • TEMPLATE (data_especifica IS NULL): a rotina que se repete TODA semana
--     no `dia_semana`. É o que o usuário monta uma vez e fica valendo.
--   • PONTUAL (data_especifica preenchida): compromisso de UMA data só, vindo
--     da Agenda ("reunião sábado 13h"). Aparece só naquela semana e não polui
--     o template — por isso a Sora marca "apenas uma vez".
--
-- Privacidade: rotina é PESSOAL (como hábitos/agenda) → filtra por user_id.
-- Idempotente. Aplicar: Supabase → SQL Editor → Run.
-- =====================================================================

create table if not exists public.rotina_blocos (
  id              uuid primary key default gen_random_uuid(),
  grupo_id        uuid not null references public.grupos(id) on delete cascade,
  user_id         uuid references public.users(id) on delete cascade,
  dia_semana      smallint not null check (dia_semana between 1 and 7),  -- 1=Seg … 7=Dom
  hora            text    not null,                                       -- 'HH:MM' (início)
  titulo          text    not null,
  cor             text,                                                   -- hex opcional
  -- NULL = template semanal (repete); data = bloco pontual só nesse dia.
  data_especifica date,
  -- Origem na Agenda, quando veio de um compromisso (evita duplicar no sync).
  compromisso_id  uuid,
  created_at      timestamptz default now()
);

-- Leitura do card: pega a rotina da pessoa por dia.
create index if not exists idx_rotina_user_dia
  on public.rotina_blocos (user_id, dia_semana);

-- Blocos pontuais de uma semana (filtro por data).
create index if not exists idx_rotina_data
  on public.rotina_blocos (data_especifica) where data_especifica is not null;

-- Um compromisso da agenda só pode virar UM bloco (o "apenas uma vez").
create unique index if not exists idx_rotina_compromisso
  on public.rotina_blocos (compromisso_id) where compromisso_id is not null;

-- =====================================================================
-- Verificação:
--   select dia_semana, hora, titulo, data_especifica from public.rotina_blocos
--    where user_id = '<seu_user>' order by dia_semana, hora;
-- =====================================================================
