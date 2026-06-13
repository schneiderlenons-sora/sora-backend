-- =====================================================================
-- 040 — Toggles de compartilhamento do Grow (por aba, por grupo).
--
-- Hábitos, Saúde, Tarefas e Agenda são SEMPRE privados (não têm flag).
-- Casa (Compras/Despensa/Receitas/Manutenções) e as 3 Coleções têm
-- liga/desliga por grupo. Default = false (privado / opt-in pra compartilhar).
-- Quando true, a leitura passa a filtrar por grupo_id (pool do grupo);
-- quando false, por user_id (só o seu). Alternar NÃO migra dado.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.grupos add column if not exists grow_compartilha_casa     boolean default false;
alter table public.grupos add column if not exists grow_compartilha_viagens  boolean default false;
alter table public.grupos add column if not exists grow_compartilha_midia    boolean default false;
alter table public.grupos add column if not exists grow_compartilha_leituras boolean default false;
