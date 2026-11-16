-- =============================================================================
-- 196 — Categorias PRÓPRIAS do Sora Negócios (com ícone e natureza)
--
-- Pedido de cliente (nov/2026): criar categorias além da lista padrão e
-- escolher um ícone pra elas. Antes o "Outra" do formulário aceitava um nome
-- digitado, mas não o guardava: cada lançamento digitava de novo (medido:
-- 7 de 15 empresas faziam isso; a mesma categoria aparecia escrita de 3 jeitos).
--
-- O lançamento continua guardando o NOME em `lancamentos_negocio.categoria`
-- (texto livre desde a 091). Esta tabela só guarda o que o nome sozinho não
-- carrega: o ícone, a natureza (fixa/variável, pro ponto de equilíbrio do DRE)
-- e se a categoria foi tirada da lista.
--
-- Sem esta migration: o painel segue igual a hoje (lista padrão + "Outra"), e
-- as categorias já digitadas aparecem na lista pra reaproveitar, só sem ícone.
-- Idempotente.
-- =============================================================================

create table if not exists public.categorias_negocio (
  id          uuid primary key default gen_random_uuid(),
  empresa_id  uuid not null references public.empresas(id) on delete cascade,
  tipo        text not null check (tipo in ('entrada', 'saida')),
  nome        text not null check (char_length(nome) between 1 and 30),
  -- Nome de um ícone do Lucide, da lista fechada do painel (null = sem ícone).
  icone       text,
  -- Só pra saída: entra no DRE como despesa fixa ou variável (null = variável).
  natureza    text check (natureza in ('fixa', 'variavel')),
  -- Tirada da lista sem mexer nos lançamentos que já a usam.
  oculta      boolean not null default false,
  criado_por  uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ⚠️ A TABELA JÁ EXISTIA: a migration 105 (fase 1 do Negócios) criou uma
-- `categorias_negocio` que nunca foi usada (0 linhas), só com id, empresa_id,
-- tipo, nome, icone, ativa e created_at. Nesse banco o `create table if not
-- exists` acima não faz nada — por isso as colunas novas entram aqui, uma a
-- uma. (A coluna `ativa` da 105 fica; o código não a usa.)
alter table public.categorias_negocio add column if not exists natureza   text;
alter table public.categorias_negocio add column if not exists oculta     boolean not null default false;
alter table public.categorias_negocio add column if not exists criado_por uuid references public.users(id) on delete set null;
alter table public.categorias_negocio add column if not exists updated_at timestamptz not null default now();
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'categorias_negocio_natureza_check') then
    alter table public.categorias_negocio
      add constraint categorias_negocio_natureza_check check (natureza in ('fixa', 'variavel'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'categorias_negocio_nome_tamanho_check') then
    alter table public.categorias_negocio
      add constraint categorias_negocio_nome_tamanho_check check (char_length(nome) between 1 and 30);
  end if;
end $$;

-- Uma categoria por nome dentro da empresa e do tipo, ignorando caixa e acento
-- ("Conveniência" e "CONVENIENCIA" são a mesma).
-- ⚠️ translate() e não a extensão unaccent: no Supabase ela mora no schema
-- `extensions` e não é IMMUTABLE, então não serve pra índice. Mesma regra de
-- `chave()` em src/services/categoriasNegocio.js.
create or replace function public.chave_categoria_negocio(t text)
  returns text language sql immutable parallel safe
  as $$ select regexp_replace(trim(translate(lower(t),
    'áàâãäéèêëíìîïóòôõöúùûüçñ', 'aaaaaeeeeiiiiooooouuuucn')), '[_[:space:]]+', ' ', 'g') $$;

create unique index if not exists uq_categorias_negocio_nome
  on public.categorias_negocio (empresa_id, tipo, public.chave_categoria_negocio(nome));

create index if not exists idx_categorias_negocio_empresa
  on public.categorias_negocio (empresa_id);

-- Mesmo padrão das tabelas do Negócios: só o backend (service role) acessa.
alter table public.categorias_negocio enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies
      where schemaname = 'public' and tablename = 'categorias_negocio'
        and policyname = 'categorias_negocio_service_role') then
    create policy categorias_negocio_service_role on public.categorias_negocio
      for all to service_role using (true) with check (true);
  end if;
end $$;
