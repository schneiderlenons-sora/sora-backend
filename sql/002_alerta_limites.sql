-- =====================================================================
-- 002 — Campos de alerta para limites (geral + por categoria)
-- Idempotente.
-- =====================================================================

-- Limite geral por usuário (mora em public.users)
alter table public.users
  add column if not exists meta_mensal_ativo            boolean default true,
  add column if not exists meta_mensal_alerta_ativo     boolean default true,
  add column if not exists meta_mensal_alerta_pct       smallint default 80
    check (meta_mensal_alerta_pct between 0 and 100);

-- Toggle on/off por categoria sem precisar deletar a linha
alter table public.category_limits
  add column if not exists ativo boolean default true;

-- Update silencioso de linhas antigas (mantém comportamento atual: ativo)
update public.category_limits set ativo = true where ativo is null;
