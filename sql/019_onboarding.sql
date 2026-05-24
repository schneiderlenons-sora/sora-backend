-- =====================================================================
-- 019 — Onboarding wizard
-- Adiciona colunas pra rastrear o progresso do wizard de boas-vindas
-- (perfil de uso, objetivo principal, step atual, completo).
-- Idempotente.
-- =====================================================================

alter table public.users
  add column if not exists onboarding_completed boolean default false,
  add column if not exists onboarding_step       integer default 0,
  add column if not exists perfil_uso            text
    check (perfil_uso in ('pessoal', 'casal', 'empresarial', 'ambos')),
  add column if not exists objetivo_principal    text
    check (objetivo_principal in ('vermelho', 'meta', 'organizar', 'negocio'));

-- =====================================================================
-- Marcar usuários já existentes como onboarding_completed = true
-- pra eles não serem forçados a fazer (são pré-existentes).
-- =====================================================================

update public.users
   set onboarding_completed = true
 where onboarding_completed is null or onboarding_completed = false;

-- Restaura o default false (apenas pra novos usuários ficarem com false)
-- já foi feito no add column; o update acima só serve pra usuários velhos.

-- =====================================================================
-- Verificação:
--   select id, name, onboarding_completed, onboarding_step, perfil_uso
--     from public.users limit 5;
-- =====================================================================
