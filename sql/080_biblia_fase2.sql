-- =====================================================================
-- 080 — Bíblia · Fase 2 (profundidade): oração + memorização
--
-- Complementa a 079 (plano + leituras). Mesmo padrão grupo_id + user_id.
-- O "diário devocional" NÃO precisa de tabela nova — reusa as reflexões já
-- gravadas em biblia_leituras.reflexao.
-- Idempotente. Aplicar: Supabase → SQL Editor → Run.
-- =====================================================================

-- ── LISTA DE ORAÇÃO ──────────────────────────────────────────────────
create table if not exists public.biblia_oracoes (
  id            uuid primary key default gen_random_uuid(),
  grupo_id      uuid not null references public.grupos(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  pedido        text not null,
  respondida    boolean not null default false,
  respondida_em date,
  created_at    timestamptz default now()
);
create index if not exists idx_biblia_oracoes_user
  on public.biblia_oracoes (user_id, respondida, created_at desc);

-- ── MEMORIZAÇÃO (repetição espaçada) ─────────────────────────────────
-- nivel 0..6 → intervalo crescente. proxima_revisao = quando reaparece.
create table if not exists public.biblia_memorizacao (
  id              uuid primary key default gen_random_uuid(),
  grupo_id        uuid not null references public.grupos(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  referencia      text not null,
  texto           text,
  nivel           int  not null default 0 check (nivel between 0 and 6),
  proxima_revisao date not null default current_date,
  ultima_revisao  date,
  created_at      timestamptz default now()
);
create index if not exists idx_biblia_memo_user_revisao
  on public.biblia_memorizacao (user_id, proxima_revisao);

-- =====================================================================
-- Verificação:
--   select pedido, respondida from public.biblia_oracoes;
--   select referencia, nivel, proxima_revisao from public.biblia_memorizacao;
-- =====================================================================
