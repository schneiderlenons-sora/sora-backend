-- =====================================================================
-- 032 — Despensa (pantry) + loop com a lista de compras
--
-- O usuário cadastra o que costuma ter em casa. Cada item tem status:
--   tem · acabando · acabou
-- Quando vira "acabando"/"acabou", entra automaticamente na lista de
-- compras (link despensa_item_id). Quando o item da lista é marcado como
-- comprado, a despensa volta pra "tem" — fechando o ciclo.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

create table if not exists public.despensa_itens (
  id               uuid primary key default gen_random_uuid(),
  grupo_id         uuid not null references public.grupos(id) on delete cascade,
  nome             text not null,
  categoria        text,
  status           text not null default 'tem' check (status in ('tem','acabando','acabou')),
  quantidade_ideal text,
  unidade          text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create index if not exists idx_despensa_grupo on public.despensa_itens(grupo_id);

-- Liga o item da lista de compras de volta ao item da despensa (fecha o ciclo)
alter table public.itens_lista_compras
  add column if not exists despensa_item_id uuid
    references public.despensa_itens(id) on delete set null;
