-- =====================================================================
-- 069 — Open Finance (camada AGREGADOR-AGNÓSTICA)
-- Prepara a Sora pra puxar TUDO via Open Finance (contas, cartões inclusive
-- virtuais, caixinhas/objetivos, investimentos e transações) por qualquer
-- provedor (Polp agora; Pluggy legado continua funcionando pelas colunas antigas).
--
-- Mapeamento na Sora:
--   conta/cartão OF → wallets            (via wallets.of_conta_id + of_provider)
--   transação OF    → transacoes         (dedup por transacoes.of_tx_id)
--   caixinha/obj.   → of_caixinhas       (NOVO — a Sora não tinha esse conceito)
--   investimento OF → investimentos      (via investimentos.of_id + origem)
--
-- Idempotente. Rodar no Supabase → SQL Editor.
-- =====================================================================

-- ── Conexões OF (generaliza pluggy_items, com coluna provider) ─────────────
create table if not exists public.of_conexoes (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references public.users(id)  on delete cascade,
  grupo_id          uuid references public.grupos(id) on delete cascade,
  provider          text not null default 'polp',   -- 'polp' | 'pluggy' | ...
  external_id       text not null,                  -- id da conexão/integração no provedor
  instituicao       text,                           -- nome do banco (ex.: "Nubank")
  status            text default 'updating',        -- updating | updated | error
  consent_expira_em timestamptz,                    -- validade do consentimento (BACEN)
  ultimo_erro       text,
  ultima_sync       timestamptz,
  created_at        timestamptz default now(),
  unique (provider, external_id)
);
create index if not exists idx_of_conexoes_user  on public.of_conexoes(user_id);
create index if not exists idx_of_conexoes_grupo on public.of_conexoes(grupo_id);

-- ── Conta/cartão OF → wallet (generaliza wallets.pluggy_account_id) ────────
alter table public.wallets add column if not exists of_conta_id text;
alter table public.wallets add column if not exists of_provider text;
create index if not exists idx_wallets_of_conta on public.wallets(of_conta_id);

-- ── Dedup de transações importadas por OF (generaliza pluggy_tx_id) ────────
alter table public.transacoes add column if not exists of_tx_id text;
create unique index if not exists uq_transacoes_of_tx
  on public.transacoes(of_tx_id) where of_tx_id is not null;
-- Final do cartão virtual por transação (Nubank etc.) — separa cartões na mesma conta
alter table public.transacoes add column if not exists of_card text;

-- ── Caixinhas / objetivos (Nubank Caixinhas, reservas, metas do banco) ─────
create table if not exists public.of_caixinhas (
  id            uuid primary key default gen_random_uuid(),
  conexao_id    uuid references public.of_conexoes(id) on delete cascade,
  user_id       uuid references public.users(id),
  grupo_id      uuid references public.grupos(id) on delete cascade,
  provider      text default 'polp',
  external_id   text not null,
  nome          text,
  tipo          text,                       -- caixinha | objetivo | reserva | poupanca
  saldo         numeric(14,2) default 0,
  meta_valor    numeric(14,2),              -- alvo do objetivo (quando houver)
  moeda         text default 'BRL',
  atualizado_em timestamptz,
  created_at    timestamptz default now(),
  unique (provider, external_id)
);
create index if not exists idx_of_caixinhas_grupo on public.of_caixinhas(grupo_id);

-- ── Investimentos OF na tabela existente (dedup + origem manual/of) ────────
alter table public.investimentos add column if not exists of_id       text;
alter table public.investimentos add column if not exists of_provider text;
alter table public.investimentos add column if not exists origem      text default 'manual';
create unique index if not exists uq_investimentos_of
  on public.investimentos(of_id) where of_id is not null;

-- =====================================================================
-- Verificação:
--   select * from public.of_conexoes limit 5;
--   select column_name from information_schema.columns
--     where table_name='wallets' and column_name in ('of_conta_id','of_provider');
-- =====================================================================
