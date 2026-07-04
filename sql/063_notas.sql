-- =====================================================================
-- 063 — Notas / insights rápidos do Grow.
-- Salvar por áudio/texto pelo WhatsApp ("anota que ...", "tive uma ideia ...")
-- e consultar depois ("o que anotei sobre ...", "minhas notas").
-- Base do Grow (todos os planos pagos). Privado por user_id (como Tarefas/Agenda).
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

create table if not exists public.notas (
  id         uuid primary key default gen_random_uuid(),
  grupo_id   uuid references public.grupos(id) on delete cascade,
  user_id    uuid references public.users(id),
  texto      text not null,
  titulo     text,
  categoria  text,
  origem     text default 'texto' check (origem in ('texto', 'audio')),
  created_at timestamptz default now()
);

create index if not exists idx_notas_user on public.notas(user_id, created_at desc);
