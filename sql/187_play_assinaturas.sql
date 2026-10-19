-- =====================================================================
-- 187 — Assinaturas compradas pela GOOGLE PLAY (app Android).
--
-- Dentro do app a Sora só pode vender pela cobrança do Google. Cada compra
-- gera um `purchase_token`; esta tabela liga o token à conta Sora e guarda o
-- último estado lido na API do Google (lib/play-sync.ts no frontend).
--
-- `users.plano_fonte = 'play'` marca quem ganhou o plano PELA PLAY — é o que
-- impede um aviso de expiração da Play de rebaixar um vitalício, um assinante
-- do Stripe ou uma cortesia do admin (lib/play-billing.ts → decidirPatchUsuario).
--
-- Sem RLS aberta: só o servidor (service role) lê e escreve.
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

create table if not exists public.play_assinaturas (
  purchase_token        text primary key,
  user_id               uuid not null references public.users(id) on delete cascade,
  product_id            text,
  plano                 text,
  intervalo             text,
  estado                text not null,
  expira_em             timestamptz,
  auto_renova           boolean,
  linked_purchase_token text,
  reconhecida           boolean not null default false,
  pedido_id             text,
  teste                 boolean not null default false,
  criado_em             timestamptz not null default now(),
  atualizado_em         timestamptz not null default now()
);

create index if not exists idx_play_assinaturas_user on public.play_assinaturas(user_id);

alter table public.play_assinaturas enable row level security;

alter table public.users add column if not exists plano_fonte text;
