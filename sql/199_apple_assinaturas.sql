-- =====================================================================
-- 199 — Assinaturas compradas pela APPLE (app de iPhone, StoreKit).
--
-- Irmã da 187 (Google Play). Cada assinatura da Apple tem um
-- `original_transaction_id` fixo (não muda nas renovações nem na troca de
-- plano dentro do grupo); esta tabela liga esse id à conta Sora e guarda o
-- último estado lido na App Store (lib/apple-sync.ts no frontend).
--
-- `users.plano_fonte = 'apple'` marca quem ganhou o plano PELA APPLE — é o que
-- impede o vencimento de uma assinatura da Apple de rebaixar um vitalício, um
-- assinante do site, da Play ou uma cortesia (lib/apple-billing.ts).
-- A coluna `plano_fonte` já existe (187); sem CHECK, aceita 'apple'.
--
-- `ambiente` = 'Production' ou 'Sandbox'. Sandbox é TestFlight, testador e a
-- própria revisão da Apple — compra de teste, sem dinheiro.
--
-- Sem RLS aberta: só o servidor (service role) lê e escreve.
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

create table if not exists public.apple_assinaturas (
  original_transaction_id text primary key,
  user_id                 uuid not null references public.users(id) on delete cascade,
  transacao_id            text,
  product_id              text,
  plano                   text,
  intervalo               text,
  estado                  text not null,
  expira_em               timestamptz,
  auto_renova             boolean,
  proximo_produto         text,
  conta_na_compra         uuid,
  ambiente                text,
  criado_em               timestamptz not null default now(),
  atualizado_em           timestamptz not null default now()
);

create index if not exists idx_apple_assinaturas_user on public.apple_assinaturas(user_id);

alter table public.apple_assinaturas enable row level security;

-- A 187 já cria a coluna; repetido aqui pra 199 funcionar sozinha.
alter table public.users add column if not exists plano_fonte text;
