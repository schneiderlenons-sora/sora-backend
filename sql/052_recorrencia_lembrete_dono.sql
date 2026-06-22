-- 052: dono (criado_por) em recorrencias e lembretes
-- Pra que os lembretes de vencimento (recorrencia/conta) vao pro DONO do item,
-- nao pro dono do grupo. Em grupo compartilhado, cada um recebe so o que e seu.
-- Backfill: linhas antigas viram do dono do grupo (mantem o comportamento atual).
-- Idempotente.

alter table public.recorrencias add column if not exists criado_por uuid references public.users(id);
alter table public.lembretes   add column if not exists criado_por uuid references public.users(id);

update public.recorrencias r
   set criado_por = g.dono_id
  from public.grupos g
 where r.grupo_id = g.id and r.criado_por is null;

update public.lembretes l
   set criado_por = g.dono_id
  from public.grupos g
 where l.grupo_id = g.id and l.criado_por is null;

create index if not exists idx_recorrencias_criado_por on public.recorrencias(criado_por);
create index if not exists idx_lembretes_criado_por   on public.lembretes(criado_por);
