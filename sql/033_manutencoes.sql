-- =====================================================================
-- 033 — Manutenções da casa (upkeep recorrente)
--
-- Coisas periódicas que a gente esquece: trocar filtro de água (3 meses),
-- limpar ar-condicionado (6 meses), dedetização (1 ano), revisão do carro.
-- A próxima data = ultima_data + frequencia_dias. Lembrete opt-in por item:
-- a Sora avisa no WhatsApp quando vence (e re-cutuca a cada ~7 dias se
-- continuar atrasada). Dedup via lembrete_ultimo.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

create table if not exists public.manutencoes (
  id              uuid primary key default gen_random_uuid(),
  grupo_id        uuid not null references public.grupos(id) on delete cascade,
  nome            text not null,
  icone           text default '🔧',
  frequencia_dias int not null default 90,
  ultima_data     date,                       -- última vez feita (null = nunca)
  observacao      text,
  lembrete_ativo  boolean default false,
  lembrete_ultimo date,                       -- dedup do aviso no WhatsApp
  created_at      timestamptz default now()
);

create index if not exists idx_manutencoes_grupo on public.manutencoes(grupo_id);
