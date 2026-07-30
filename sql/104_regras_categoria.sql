-- =====================================================================
-- 104 — Regras de categoria por ESTABELECIMENTO ("aprender" com a correção)
--
-- Problema real: maquininha de barbearia/dentista/consultório costuma vir com o
-- nome da PESSOA, não do negócio — "FernandoPeixoto", "MariaLana". Nenhuma regra
-- fixa acerta isso, então cai em "Outros"; e como o nome se repete todo mês, o
-- usuário corrige a mesma coisa pra sempre.
--
-- Aqui a correção vira REGRA do grupo: ao editar a categoria de uma transação,
-- o painel oferece aplicar a todas as do mesmo estabelecimento — as que já
-- existem E as que chegarem depois (o categorizador consulta esta tabela ANTES
-- das regras fixas do código).
--
-- `termo` é a descrição NORMALIZADA (minúscula, sem acento/pontuação), pra casar
-- "FernandoPeixoto" com "FERNANDO PEIXOTO" e "Pix - fernandopeixoto".
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

create table if not exists public.regras_categoria (
  id         uuid primary key default gen_random_uuid(),
  grupo_id   uuid not null references public.grupos(id) on delete cascade,
  termo      text not null,
  categoria  text not null,
  criado_por uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Uma regra por termo em cada grupo: corrigir de novo ATUALIZA (upsert), não
-- empilha duas regras conflitantes pro mesmo estabelecimento.
create unique index if not exists uq_regras_categoria_grupo_termo
  on public.regras_categoria(grupo_id, lower(btrim(termo)));

-- O categorizador lê todas as regras do grupo a cada lote de importação.
create index if not exists idx_regras_categoria_grupo
  on public.regras_categoria(grupo_id);

alter table public.regras_categoria enable row level security;

-- Escrita/leitura passam pelo backend (service role), igual ao resto do app.
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'regras_categoria'
       and policyname = 'regras_categoria_service_role'
  ) then
    create policy regras_categoria_service_role on public.regras_categoria
      for all to service_role using (true) with check (true);
  end if;
end $$;
