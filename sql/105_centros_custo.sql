-- =====================================================================
-- 105 — Centro de custo e categorias próprias do negócio (Sora Negócios, fase 1)
--
-- ⚠️ NÃO existe tabela de "contas a receber" aqui, DE PROPÓSITO.
-- Conta a receber é `lancamentos_negocio` com tipo='entrada' e
-- status='pendente' — exatamente o espelho de "conta a pagar = saída
-- pendente", que já funciona desde a migration 091. Criar uma tabela paralela
-- significaria duas máquinas pro mesmo fato (baixa, vencimento, vínculo com
-- conta, entrada no DRE) e duas chances de divergirem.
--
-- 1. CENTRO DE CUSTO — responde "qual parte do negócio consumiu isto".
--    Ex.: Loja física · Loja online · Marketing · Produção · Administrativo.
--    Sem ele, o dono vê "gastei 4.000 em fornecedor" e não sabe quanto foi da
--    loja e quanto foi do online.
--
-- 2. CATEGORIAS DO NEGÓCIO — hoje a categoria é texto livre com um catálogo
--    fixo no código (lib/lancamentos.ts). Funciona, mas o usuário não consegue
--    criar a dele: uma oficina quer "peças", um salão quer "produtos".
--    Esta tabela é ADITIVA: linha nenhuma é obrigatória, e o catálogo do código
--    segue valendo como padrão pra quem não personalizar.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

-- ── 1. Centros de custo ──────────────────────────────────────────────
create table if not exists public.centros_custo (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  nome       text not null,
  cor        text,
  ativo      boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_centros_custo_empresa
  on public.centros_custo(empresa_id) where ativo;

-- Nome único por empresa (evita "Loja" duplicado que quebra o relatório).
create unique index if not exists uq_centros_custo_empresa_nome
  on public.centros_custo(empresa_id, lower(btrim(nome)));

-- Vínculo no lançamento. Nullable: lançamento sem centro é o normal pra quem
-- não usa o recurso, e o relatório agrupa esses em "Sem centro".
alter table public.lancamentos_negocio
  add column if not exists centro_custo_id uuid references public.centros_custo(id) on delete set null;

create index if not exists idx_lancamentos_centro
  on public.lancamentos_negocio(centro_custo_id) where centro_custo_id is not null;

-- ── 2. Categorias do negócio (opcionais, por empresa) ────────────────
create table if not exists public.categorias_negocio (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  tipo       text not null check (tipo in ('entrada', 'saida')),
  nome       text not null,
  icone      text,
  ativa      boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_categorias_negocio_empresa
  on public.categorias_negocio(empresa_id, tipo) where ativa;

create unique index if not exists uq_categorias_negocio
  on public.categorias_negocio(empresa_id, tipo, lower(btrim(nome)));

-- ── RLS: escrita/leitura pelo backend (service role), como o resto do app ──
alter table public.centros_custo      enable row level security;
alter table public.categorias_negocio enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
      where schemaname='public' and tablename='centros_custo' and policyname='centros_custo_service_role') then
    create policy centros_custo_service_role on public.centros_custo
      for all to service_role using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies
      where schemaname='public' and tablename='categorias_negocio' and policyname='categorias_negocio_service_role') then
    create policy categorias_negocio_service_role on public.categorias_negocio
      for all to service_role using (true) with check (true);
  end if;
end $$;
