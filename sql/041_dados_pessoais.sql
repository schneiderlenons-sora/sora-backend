-- =====================================================================
-- 041 — Aba "Dados Pessoais" do Sora Grow (privada por usuário) + PIN de
-- 4 dígitos (trava de UI).
--
-- Hierarquia: Quadro → Seção (mini-quadro) → Item (campo/nota/senha/arquivo).
-- Tudo escopo por user_id (NÃO compartilhável por grupo).
-- O PIN é um hash com salt (nunca o número puro); trava após 5 erros.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

-- ── PIN da aba (em users) ────────────────────────────────────────────
alter table public.users add column if not exists grow_pin_hash       text;
alter table public.users add column if not exists grow_pin_ativo       boolean default false;
alter table public.users add column if not exists grow_pin_erros       int default 0;
alter table public.users add column if not exists grow_pin_travado_ate timestamptz;

-- ── Quadros (nível 1) ────────────────────────────────────────────────
create table if not exists public.dados_quadros (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  nome       text not null,
  cor        text default '#7c3aed',
  icone      text default '📁',
  ordem      int  default 0,
  created_at timestamptz default now()
);
create index if not exists idx_dados_quadros_user on public.dados_quadros(user_id);

-- ── Seções / mini-quadros (nível 2) ──────────────────────────────────
create table if not exists public.dados_secoes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  quadro_id  uuid not null references public.dados_quadros(id) on delete cascade,
  nome       text not null,
  icone      text default '🗂️',
  ordem      int  default 0,
  created_at timestamptz default now()
);
create index if not exists idx_dados_secoes_quadro on public.dados_secoes(quadro_id);
create index if not exists idx_dados_secoes_user   on public.dados_secoes(user_id);

-- ── Itens (nível 3) ──────────────────────────────────────────────────
-- tipo: 'campo' (rótulo+valor curto) | 'nota' (texto longo) | 'senha'
--       (valor mascarado na UI) | 'arquivo' (fase 2: upload via Storage)
create table if not exists public.dados_itens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  secao_id      uuid not null references public.dados_secoes(id) on delete cascade,
  tipo          text default 'campo',
  titulo        text,
  valor         text,
  arquivo_url   text,
  arquivo_nome  text,
  ordem         int  default 0,
  created_at    timestamptz default now()
);
create index if not exists idx_dados_itens_secao on public.dados_itens(secao_id);
create index if not exists idx_dados_itens_user  on public.dados_itens(user_id);
