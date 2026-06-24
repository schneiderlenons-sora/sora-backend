-- 058: sugestões de gasto fixo que o usuário DISPENSOU.
-- Sem isso, ao recarregar a aba a mesma sugestão voltava (dispensar era só no
-- front). Guarda a "chave" (descrição normalizada) por grupo. Idempotente.

create table if not exists public.recorrencias_dispensadas (
  id         uuid primary key default gen_random_uuid(),
  grupo_id   uuid references public.grupos(id) on delete cascade,
  chave      text not null,
  created_at timestamptz default now(),
  unique (grupo_id, chave)
);

create index if not exists idx_rec_dispensadas_grupo on public.recorrencias_dispensadas(grupo_id);
