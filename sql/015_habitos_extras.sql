-- =====================================================================
-- 015 — Hábitos extras: motivo, tipo, ordem
-- Idempotente.
-- =====================================================================

alter table public.habitos add column if not exists motivo text;
alter table public.habitos add column if not exists tipo text default 'construir' check (tipo in ('construir','eliminar'));
alter table public.habitos add column if not exists ordem int default 0;

create index if not exists idx_habitos_grupo_ordem on public.habitos(grupo_id, ordem) where ativo = true;
