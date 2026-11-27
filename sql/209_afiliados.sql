-- =============================================================================
-- 209 — Programa de afiliados: código, clientes trazidos e comissões
--
-- A 153 só guardava a CANDIDATURA. Aqui nasce o que paga alguém:
--   · afiliados          → quem foi aprovado, com o código e o desconto;
--   · afiliado_indicados → cada cliente pertence a NO MÁXIMO um afiliado;
--   · afiliado_comissoes → uma linha por cobrança que rendeu comissão.
--
-- Valores em CENTAVOS (inteiro). As regras (percentuais, carência, estorno)
-- ficam em sora-frontend/lib/afiliados-regras.ts, com eval.
--
-- Só o servidor (service_role) lê e escreve: RLS ligada e sem política.
--
-- Aplicar: Supabase Dashboard → SQL Editor → Run. Idempotente.
-- =============================================================================

create table if not exists public.afiliados (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null unique references public.users(id) on delete cascade,
  codigo          text not null,
  desconto_pct    integer not null check (desconto_pct between 1 and 50),
  ativo           boolean not null default true,
  stripe_cupom_id text,
  stripe_promo_id text,
  sincronizado_em timestamptz,
  criado_em       timestamptz not null default now(),
  constraint afiliados_codigo_formato check (codigo ~ '^[A-Z][A-Z0-9]{2,19}$')
);

create unique index if not exists afiliados_codigo_unico on public.afiliados (codigo);

create table if not exists public.afiliado_indicados (
  -- a chave é o CLIENTE: ninguém rende comissão pra duas pessoas
  user_id     uuid primary key references public.users(id) on delete cascade,
  afiliado_id uuid not null references public.afiliados(id) on delete cascade,
  origem      text not null check (origem in ('link', 'codigo')),
  criado_em   timestamptz not null default now()
);

create index if not exists idx_afiliado_indicados_afiliado on public.afiliado_indicados (afiliado_id);

create table if not exists public.afiliado_comissoes (
  id             uuid primary key default gen_random_uuid(),
  afiliado_id    uuid not null references public.afiliados(id) on delete cascade,
  -- se o cliente excluir a conta, o histórico do que se deve/pagou FICA
  cliente_id     uuid references public.users(id) on delete set null,
  origem         text not null check (origem in ('stripe', 'mercadopago')),
  -- id da fatura (Stripe) ou "mp_<pagamento>": é o que impede contar 2×
  referencia     text not null,
  -- 0 = a comissão da cobrança; 1, 2… = ajustes (estorno depois de já pago)
  ajuste_n       integer not null default 0 check (ajuste_n >= 0),
  tipo           text not null check (tipo in ('primeira', 'renovacao', 'vitalicio')),
  pct            integer not null check (pct between 0 and 100),
  base_centavos  integer not null check (base_centavos >= 0),
  valor_centavos integer not null,
  status         text not null default 'pendente' check (status in ('pendente', 'paga', 'cancelada')),
  pago_em        timestamptz not null,          -- quando o CLIENTE pagou
  liberada_em    timestamptz not null,          -- pago_em + carência
  repassada_em   timestamptz,                   -- quando o AFILIADO recebeu
  criado_em      timestamptz not null default now(),
  constraint afiliado_comissoes_ref_unica unique (referencia, ajuste_n),
  -- só ajuste pode ser negativo
  constraint afiliado_comissoes_sinal check (valor_centavos >= 0 or ajuste_n > 0),
  constraint afiliado_comissoes_repasse check ((status = 'paga') = (repassada_em is not null))
);

create index if not exists idx_afiliado_comissoes_afiliado on public.afiliado_comissoes (afiliado_id, pago_em desc);
create index if not exists idx_afiliado_comissoes_cliente on public.afiliado_comissoes (cliente_id);

alter table public.afiliados          enable row level security;
alter table public.afiliado_indicados enable row level security;
alter table public.afiliado_comissoes enable row level security;
