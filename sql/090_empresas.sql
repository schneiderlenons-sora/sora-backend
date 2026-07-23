-- =============================================================================
-- 090_empresas.sql — FUNDAÇÃO do Negócios 2.0 (multi-empresa + negócio físico)
--
-- Hoje a aba Negócios assume UM negócio por grupo: todas as tabelas são
-- escopadas só por user_id + grupo_id, e config_negocio tem user_id como
-- PRIMARY KEY (o que impede um usuário ter duas configurações).
--
-- Esta migration cria a tabela `empresas` e amarra tudo nela, SEM perder nada:
-- quem já usa ganha automaticamente uma empresa "Meu negócio" com todos os
-- dados existentes vinculados (backfill abaixo).
--
-- ⚠️ RODAR ANTES do deploy do código novo — o backend passa a filtrar por
-- empresa_id. Idempotente: pode rodar mais de uma vez sem duplicar nada.
-- =============================================================================

-- ── 1. EMPRESAS ────────────────────────────────────────────────────
create table if not exists public.empresas (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id)  on delete cascade,
  grupo_id    uuid not null references public.grupos(id) on delete cascade,
  nome        text not null,
  -- digital = infoprodutor (integrações/DRE) · fisico = loja (caixa/contas/equipe)
  -- hibrido = os dois. A ABA SE ADAPTA a este campo.
  tipo        text not null default 'digital'
              check (tipo in ('digital','fisico','hibrido')),
  -- Logo: data URL (mesmo padrão de marcas_personalizadas — crop no canvas,
  -- sem bucket). `icone` é o fallback quando não há logo (nome do ícone Lucide).
  logo_url    text,
  icone       text default 'Store',
  -- Cor de destaque da empresa (a aba "veste" essa cor pra você saber onde está)
  cor         text default '#61D17B',
  cnpj        text,
  ativa       boolean not null default true,
  created_at  timestamptz default now()
);

create index if not exists idx_empresas_user  on public.empresas(user_id);
create index if not exists idx_empresas_grupo on public.empresas(grupo_id);

-- ── 2. empresa_id nas tabelas existentes (nullable por enquanto) ───
alter table public.integracoes         add column if not exists empresa_id uuid references public.empresas(id) on delete cascade;
alter table public.eventos_financeiros add column if not exists empresa_id uuid references public.empresas(id) on delete cascade;
alter table public.custos_negocio      add column if not exists empresa_id uuid references public.empresas(id) on delete cascade;
alter table public.dre_snapshots       add column if not exists empresa_id uuid references public.empresas(id) on delete cascade;
alter table public.conciliacao_negocio add column if not exists empresa_id uuid references public.empresas(id) on delete cascade;
alter table public.insights_negocio    add column if not exists empresa_id uuid references public.empresas(id) on delete cascade;
alter table public.config_negocio      add column if not exists empresa_id uuid references public.empresas(id) on delete cascade;

-- ── 3. BACKFILL — ninguém perde dado ───────────────────────────────
-- Cria "Meu negócio" (digital, como era) pra cada user+grupo que já tem
-- QUALQUER registro de negócios e ainda não tem empresa.
insert into public.empresas (user_id, grupo_id, nome, tipo)
select distinct s.user_id, s.grupo_id, 'Meu negócio', 'digital'
from (
  select user_id, grupo_id from public.integracoes
  union select user_id, grupo_id from public.eventos_financeiros
  union select user_id, grupo_id from public.custos_negocio
  union select user_id, grupo_id from public.config_negocio
  union select user_id, grupo_id from public.dre_snapshots
  union select user_id, grupo_id from public.insights_negocio
) s
where s.user_id is not null and s.grupo_id is not null
  and not exists (
    select 1 from public.empresas e
    where e.user_id = s.user_id and e.grupo_id = s.grupo_id
  );

-- Carimba empresa_id nas linhas antigas (casa por user_id + grupo_id).
update public.integracoes t
   set empresa_id = e.id from public.empresas e
 where e.user_id = t.user_id and e.grupo_id = t.grupo_id and t.empresa_id is null;

update public.eventos_financeiros t
   set empresa_id = e.id from public.empresas e
 where e.user_id = t.user_id and e.grupo_id = t.grupo_id and t.empresa_id is null;

update public.custos_negocio t
   set empresa_id = e.id from public.empresas e
 where e.user_id = t.user_id and e.grupo_id = t.grupo_id and t.empresa_id is null;

update public.dre_snapshots t
   set empresa_id = e.id from public.empresas e
 where e.user_id = t.user_id and e.grupo_id = t.grupo_id and t.empresa_id is null;

-- ⚠️ conciliacao_negocio NÃO tem grupo_id (só user_id) — diferente das outras.
-- Derivamos a empresa do EVENTO vinculado: a conciliação pertence à mesma
-- empresa do evento que ela concilia. Casar por user_id seria ambíguo pra quem
-- tem mais de uma empresa.
update public.conciliacao_negocio c
   set empresa_id = ev.empresa_id
  from public.eventos_financeiros ev
 where ev.id = c.evento_id
   and c.empresa_id is null
   and ev.empresa_id is not null;

update public.insights_negocio t
   set empresa_id = e.id from public.empresas e
 where e.user_id = t.user_id and e.grupo_id = t.grupo_id and t.empresa_id is null;

update public.config_negocio t
   set empresa_id = e.id from public.empresas e
 where e.user_id = t.user_id and e.grupo_id = t.grupo_id and t.empresa_id is null;

create index if not exists idx_integracoes_empresa  on public.integracoes(empresa_id);
create index if not exists idx_eventos_empresa      on public.eventos_financeiros(empresa_id);
create index if not exists idx_custos_empresa       on public.custos_negocio(empresa_id);
create index if not exists idx_dre_empresa          on public.dre_snapshots(empresa_id);
create index if not exists idx_conciliacao_empresa  on public.conciliacao_negocio(empresa_id);
create index if not exists idx_insights_empresa     on public.insights_negocio(empresa_id);

-- ── 3b. dre_snapshots: unicidade por EMPRESA, não por usuário ──────
-- Tinha unique(user_id, periodo). Com multi-empresa, duas empresas do mesmo
-- dono colidiriam no mesmo mês (o snapshot de uma sobrescreveria o da outra).
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'dre_snapshots_user_id_periodo_key'
       and conrelid = 'public.dre_snapshots'::regclass
  ) then
    alter table public.dre_snapshots drop constraint dre_snapshots_user_id_periodo_key;
  end if;
end $$;

create unique index if not exists uq_dre_empresa_periodo
  on public.dre_snapshots(empresa_id, periodo);

-- ── 4. config_negocio: PK user_id → empresa_id ─────────────────────
-- É o que destrava o multi-empresa (antes: 1 config por USUÁRIO).
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'config_negocio_pkey' and conrelid = 'public.config_negocio'::regclass
  ) then
    alter table public.config_negocio drop constraint config_negocio_pkey;
  end if;
end $$;

-- Sem empresa_id a linha é órfã (não deveria existir após o backfill) — limpa.
delete from public.config_negocio where empresa_id is null;

alter table public.config_negocio alter column empresa_id set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'config_negocio_empresa_pkey' and conrelid = 'public.config_negocio'::regclass
  ) then
    alter table public.config_negocio
      add constraint config_negocio_empresa_pkey primary key (empresa_id);
  end if;
end $$;

-- ── 5. Receita MANUAL (loja física não tem integração) ─────────────
-- eventos_financeiros.integracao_id era NOT NULL → toda receita precisava vir
-- de Hotmart/Kiwify. Agora aceita lançamento manual.
alter table public.eventos_financeiros alter column integracao_id drop not null;
alter table public.eventos_financeiros
  add column if not exists origem text not null default 'integracao'
  check (origem in ('integracao','manual'));
