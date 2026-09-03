-- =============================================================================
-- 153 — Indique e ganhe + Seja afiliado
--
-- DUAS features, uma migration, porque as duas nascem juntas na navegação.
--
-- ⚠️ AS REGRAS DE ABUSO MORAM AQUI, NO BANCO, e não só na tela. Isto é dinheiro:
-- cada indicação vale um mês de assinatura. Validação só no frontend é um
-- pedido HTTP de distância de virar mês grátis infinito.
--
-- Aplicar: Supabase Dashboard → SQL Editor → Run. Idempotente.
-- =============================================================================

-- ── 1. O código de cada usuário ─────────────────────────────────────────────
-- Gerado na primeira visita à aba (não no cadastro): quem nunca abrir a tela
-- não ocupa código à toa, e a coluna aceita NULL sem atrapalhar ninguém.
alter table public.users
  add column if not exists codigo_indicacao text;

-- ⚠️ Índice ÚNICO PARCIAL (só quem tem código). Um `unique` cheio faria o
-- segundo usuário sem código colidir no NULL em alguns bancos — é a mesma
-- armadilha que a migration 028 já corrigiu no `phone`.
create unique index if not exists users_codigo_indicacao_key
  on public.users (codigo_indicacao)
  where codigo_indicacao is not null;

-- ── 2. As indicações ────────────────────────────────────────────────────────
create table if not exists public.indicacoes (
  id           uuid primary key default gen_random_uuid(),
  indicador_id uuid not null references public.users(id) on delete cascade,
  indicado_id  uuid not null references public.users(id) on delete cascade,
  codigo       text not null,

  -- pendente  = amigo usou o código, ainda não virou crédito
  -- creditado = crédito lançado no Stripe do indicador
  -- recusado  = bloqueada na análise (fraude, autoindicação detectada depois)
  status       text not null default 'pendente'
               check (status in ('pendente', 'creditado', 'recusado')),

  -- Rastro do crédito no Stripe, pra dar pra auditar e estornar.
  credito_stripe_id text,
  credito_valor     numeric,
  creditado_em      timestamptz,

  criado_em    timestamptz not null default now(),

  -- ⚠️ NINGUÉM INDICA A SI MESMO. No banco, não só na tela.
  constraint indicacoes_nao_auto check (indicador_id <> indicado_id)
);

-- ⚠️ UM CONVITE POR PESSOA CONVIDADA, PARA SEMPRE. Sem isto, o mesmo amigo
-- poderia colar o código de várias pessoas e gerar um mês pra cada uma.
create unique index if not exists indicacoes_indicado_unico
  on public.indicacoes (indicado_id);

create index if not exists idx_indicacoes_indicador on public.indicacoes (indicador_id);

comment on table public.indicacoes is
  'Indique e ganhe (migration 153). Uma linha por AMIGO convidado — o unique em indicado_id garante que cada pessoa só pode ser indicada uma vez na vida. O teto de 3 por indicador é aplicado na rota, porque depende de contar linhas.';

-- ── 3. As candidaturas a afiliado ───────────────────────────────────────────
create table if not exists public.afiliados_candidaturas (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,

  -- Copiados no momento do envio, de propósito: se a pessoa trocar o nome ou o
  -- e-mail depois, a candidatura tem de continuar mostrando o que foi enviado.
  nome        text,
  email       text,

  whatsapp        text,
  instagram       text,
  tiktok          text,
  como_divulgar   text,

  -- A entrada é por ANÁLISE, não automática (é o que a tela promete).
  status      text not null default 'pendente'
              check (status in ('pendente', 'aprovado', 'recusado')),
  observacao  text,          -- anotação interna do admin
  analisado_em timestamptz,

  criado_em   timestamptz not null default now()
);

-- ⚠️ UMA CANDIDATURA ABERTA POR PESSOA. Ela pode candidatar-se de novo depois
-- de uma recusa (o índice só cobre 'pendente'), mas não pode encher a fila.
create unique index if not exists afiliados_candidatura_pendente_unica
  on public.afiliados_candidaturas (user_id)
  where status = 'pendente';

create index if not exists idx_afiliados_status on public.afiliados_candidaturas (status, criado_em desc);

comment on table public.afiliados_candidaturas is
  'Candidaturas ao programa de afiliados (migration 153). Entrada por análise manual no /admin — nunca automática.';
