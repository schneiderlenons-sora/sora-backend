-- 049: dono da conta/cartão (pra identificar de quem é em grupos compartilhados).
-- Adiciona criado_por em wallets + backfill pro dono do grupo. Idempotente.

alter table public.wallets
  add column if not exists criado_por uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wallets_criado_por_fkey'
  ) then
    alter table public.wallets
      add constraint wallets_criado_por_fkey
      foreign key (criado_por) references public.users(id) on delete set null;
  end if;
end $$;

-- Backfill: contas existentes ficam com o dono do grupo.
update public.wallets w
   set criado_por = g.dono_id
  from public.grupos g
 where g.id = w.grupo_id and w.criado_por is null;

create index if not exists idx_wallets_criado_por on public.wallets(criado_por);
