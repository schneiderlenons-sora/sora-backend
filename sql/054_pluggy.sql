-- =====================================================================
-- 054 — Open Finance via Pluggy.
-- pluggy_items: cada "item" do Pluggy = uma conexão do usuário a 1 banco.
-- Dedup: transacoes.pluggy_tx_id (única) evita lançar a mesma transação 2x;
-- wallets.pluggy_account_id mapeia uma conta Pluggy a uma carteira da Sora.
-- Idempotente. Aplicar no Supabase → SQL Editor.
-- =====================================================================

create table if not exists public.pluggy_items (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references public.users(id)  on delete cascade,
  grupo_id       uuid references public.grupos(id) on delete cascade,
  item_id        text not null unique,         -- itemId do Pluggy
  connector_nome text,                          -- nome do banco (ex.: "Nubank")
  status         text default 'updating',       -- updating | updated | error
  ultimo_erro    text,
  ultima_sync    timestamptz,
  created_at     timestamptz default now()
);

create index if not exists idx_pluggy_items_user  on public.pluggy_items(user_id);
create index if not exists idx_pluggy_items_grupo on public.pluggy_items(grupo_id);

-- Dedup de transações importadas do Pluggy.
alter table public.transacoes add column if not exists pluggy_tx_id text;
create unique index if not exists uq_transacoes_pluggy_tx
  on public.transacoes(pluggy_tx_id) where pluggy_tx_id is not null;

-- Mapeia conta Pluggy → carteira da Sora (1 conta = 1 wallet).
alter table public.wallets add column if not exists pluggy_account_id text;
create index if not exists idx_wallets_pluggy_account on public.wallets(pluggy_account_id);
