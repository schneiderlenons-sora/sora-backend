-- =====================================================================
-- 005 — Campo criado_por em transacoes + FK
-- Idempotente.
-- =====================================================================

alter table public.transacoes
  add column if not exists criado_por uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transacoes_criado_por_fkey'
  ) then
    alter table public.transacoes
      add constraint transacoes_criado_por_fkey
      foreign key (criado_por) references public.users(id) on delete set null;
  end if;
end $$;

create index if not exists idx_transacoes_criado_por on public.transacoes(criado_por);
create index if not exists idx_transacoes_grupo_data on public.transacoes(grupo_id, data desc);
