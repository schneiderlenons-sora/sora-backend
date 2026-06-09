-- =====================================================================
-- 035 — Agenda / Compromissos (Sora Grow)
--
-- Compromissos nativos do usuário: reuniões, eventos, aniversários, etc.
-- Cada um tem data, hora (ou "dia todo"), categoria/cor e lembrete opt-in
-- com antecedência configurável (na hora / 10min / 1h / 1 dia antes).
-- A Sora avisa no WhatsApp quando chega a hora.
--
-- Fase 1 (MVP): eventos de data única. A coluna `recorrencia` já existe
-- pra evolução futura (eventos repetidos), mas ainda não é expandida.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

create table if not exists public.compromissos (
  id                    uuid primary key default gen_random_uuid(),
  grupo_id              uuid not null references public.grupos(id) on delete cascade,
  titulo                text not null,
  descricao             text,
  data                  date not null,            -- dia do compromisso
  hora                  text,                     -- "HH:MM" ou null (dia todo)
  local                 text,
  categoria             text default 'pessoal',   -- pessoal/trabalho/familia/saude/financas/estudos/outro
  cor                   text default '#7c3aed',
  lembrete_ativo        boolean default false,
  lembrete_antecedencia int default 60,           -- minutos antes (0 = na hora; 1440 = 1 dia)
  lembrete_enviado      boolean default false,    -- dedup do envio no WhatsApp
  recorrencia           text default 'nenhuma',   -- nenhuma/diaria/semanal/mensal (futuro)
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

create index if not exists idx_compromissos_grupo on public.compromissos(grupo_id);
create index if not exists idx_compromissos_data  on public.compromissos(grupo_id, data);
