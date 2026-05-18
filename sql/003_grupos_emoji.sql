-- =====================================================================
-- 003 — Adiciona avatar emoji em public.grupos
-- =====================================================================

alter table public.grupos
  add column if not exists emoji text default '👨‍👩‍👧';

update public.grupos set emoji = '👨‍👩‍👧' where emoji is null;
