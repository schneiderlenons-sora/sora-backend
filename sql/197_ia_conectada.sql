-- =====================================================================
-- 197 — Sora no ChatGPT (servidor MCP + OAuth próprio).
--
-- O cliente conecta o ChatGPT dele à Sora. A conversa acontece no ChatGPT;
-- a Sora só responde às ferramentas de LEITURA (src/routes/mcp.js).
--
--   ia_conexoes       uma linha por ChatGPT conectado (tokens só em sha256)
--   ia_oauth_codigos  código de autorização: uso único, 5 minutos
--   ia_acessos        o que o ChatGPT consultou (aparece na aba "ChatGPT")
--
-- ⚠️ NENHUM TOKEN EM TEXTO: as colunas *_hash guardam o sha256. Vazou a
-- tabela, não vazou acesso.
--
-- Sem RLS aberta: só o servidor (service role) lê e escreve.
-- Apagar a conta apaga tudo (on delete cascade).
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

create table if not exists public.ia_conexoes (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null references public.users(id) on delete cascade,
  cliente_id              text not null,
  cliente_nome            text not null,
  escopo                  text not null,
  recurso                 text not null,
  access_hash             text unique,
  access_expira_em        timestamptz,
  refresh_hash            text unique,
  refresh_expira_em       timestamptz,
  refresh_anterior_hash   text,
  refresh_rotacionado_em  timestamptz,
  criada_em               timestamptz not null default now(),
  ultimo_uso_em           timestamptz,
  revogada_em             timestamptz
);
create index if not exists idx_ia_conexoes_user on public.ia_conexoes(user_id);
create index if not exists idx_ia_conexoes_refresh_ant on public.ia_conexoes(refresh_anterior_hash);
alter table public.ia_conexoes enable row level security;

create table if not exists public.ia_oauth_codigos (
  codigo_hash     text primary key,
  user_id         uuid not null references public.users(id) on delete cascade,
  cliente_id      text not null,
  cliente_nome    text not null,
  redirect_uri    text not null,
  code_challenge  text not null,
  escopo          text not null,
  recurso         text not null,
  expira_em       timestamptz not null,
  usado_em        timestamptz,
  conexao_id      uuid references public.ia_conexoes(id) on delete set null,
  criado_em       timestamptz not null default now()
);
alter table public.ia_oauth_codigos enable row level security;

create table if not exists public.ia_acessos (
  id          bigserial primary key,
  conexao_id  uuid references public.ia_conexoes(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  ferramenta  text not null,
  ok          boolean not null default true,
  ms          integer,
  criado_em   timestamptz not null default now()
);
create index if not exists idx_ia_acessos_user on public.ia_acessos(user_id, criado_em desc);
alter table public.ia_acessos enable row level security;
