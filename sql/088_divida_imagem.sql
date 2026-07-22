-- =====================================================================
-- 088 — Foto da dívida (igual às metas): imagem_url guarda uma dataURL
-- pra o usuário visualizar o que está pagando (ex.: foto do aparelho).
-- Idempotente.
-- =====================================================================
alter table public.dividas add column if not exists imagem_url text;
