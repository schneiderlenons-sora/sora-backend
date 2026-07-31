-- =====================================================================
-- 106 — Clientes, produtos e vendas (Sora Negócios, fase 2)
--
-- É o coração da operação: sem produto cadastrado não existe margem, lucro por
-- item nem estoque (fase 3); sem cliente não existe cobrança nem "quem compra
-- mais".
--
-- DECISÕES QUE VALEM MAIS QUE O SCHEMA:
--
-- 1. VENDA NÃO É UMA CAIXA SEPARADA. Toda venda gera um `lancamentos_negocio`
--    de entrada — à vista nasce 'pago', a prazo nasce 'pendente' (e vira conta
--    a receber automaticamente). É a mesma escolha da folha (que gera saída) e
--    das contas a pagar. Assim o caixa, o DRE e os indicadores enxergam a venda
--    sem nenhuma ponte: uma fonte, não duas.
--
-- 2. O ITEM DA VENDA CONGELA PREÇO E CUSTO. `venda_itens` guarda os valores do
--    MOMENTO da venda, não uma referência viva ao produto. Se amanhã o preço
--    subir, a margem da venda de ontem TEM de continuar a mesma — senão o
--    histórico de lucro se reescreve sozinho toda vez que a tabela de preço
--    muda, e nenhum relatório do passado pode ser levado a sério.
--
-- 3. PRODUTO ARQUIVA, NÃO APAGA. Item vendido não pode sumir: a venda antiga
--    ficaria órfã. `ativo=false` tira das próximas vendas e preserva o passado.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

-- ── CLIENTES ─────────────────────────────────────────────────────────
create table if not exists public.clientes_negocio (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  nome       text not null,
  telefone   text,               -- só dígitos; é por aqui que a Sora cobra
  email      text,
  documento  text,               -- CPF/CNPJ (opcional)
  endereco   text,
  observacao text,
  ativo      boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_clientes_empresa
  on public.clientes_negocio(empresa_id) where ativo;
-- Busca por nome no balcão (o vendedor digita 2 letras e espera a lista).
create index if not exists idx_clientes_nome
  on public.clientes_negocio(empresa_id, lower(nome));

-- ── PRODUTOS E SERVIÇOS ──────────────────────────────────────────────
create table if not exists public.produtos_negocio (
  id           uuid primary key default gen_random_uuid(),
  empresa_id   uuid not null references public.empresas(id) on delete cascade,
  nome         text not null,
  sku          text,
  codigo_barras text,
  categoria    text,
  preco        integer not null default 0,   -- CENTAVOS (venda)
  custo        integer not null default 0,   -- CENTAVOS (compra) → margem
  unidade      text default 'un',            -- un, kg, h, m²…
  -- Serviço não tem estoque (corte de cabelo, consultoria). Sem esta flag o
  -- controle da fase 3 tentaria dar baixa em algo que não existe.
  eh_servico   boolean not null default false,
  estoque_min  integer,                      -- alerta de reposição (fase 3)
  foto_url     text,                         -- data URL, igual marcas/empresas
  ativo        boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_produtos_empresa
  on public.produtos_negocio(empresa_id) where ativo;
create index if not exists idx_produtos_nome
  on public.produtos_negocio(empresa_id, lower(nome));
-- Código de barras: leitura por scanner tem de achar em 1 hit.
create index if not exists idx_produtos_codigo
  on public.produtos_negocio(empresa_id, codigo_barras) where codigo_barras is not null;

-- SKU único por empresa quando informado (dois produtos com o mesmo SKU
-- quebram qualquer conferência de estoque).
create unique index if not exists uq_produtos_sku
  on public.produtos_negocio(empresa_id, lower(btrim(sku)))
  where sku is not null and btrim(sku) <> '';

-- ── VENDAS ───────────────────────────────────────────────────────────
create table if not exists public.vendas_negocio (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  cliente_id    uuid references public.clientes_negocio(id) on delete set null,
  -- Venda de balcão não tem cliente cadastrado, e exigir isso mataria a
  -- velocidade do caixa. `cliente_nome` guarda o nome solto quando houver.
  cliente_nome  text,
  data          date not null default (now() at time zone 'America/Sao_Paulo')::date,
  total         integer not null default 0,   -- CENTAVOS (já com desconto)
  desconto      integer not null default 0,   -- CENTAVOS
  custo_total   integer not null default 0,   -- soma dos custos congelados
  forma_pagamento text,
  status        text not null default 'pago' check (status in ('pago', 'pendente', 'cancelada')),
  vencimento    date,                          -- quando a prazo
  observacao    text,
  vendedor_id   uuid references public.funcionarios_negocio(id) on delete set null,
  conta_id      uuid references public.contas_negocio(id) on delete set null,
  -- Ponte com o caixa: a venda GERA um lançamento e guarda o id dele. Assim
  -- editar/cancelar a venda sabe exatamente qual linha do caixa mexer.
  lancamento_id uuid references public.lancamentos_negocio(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_vendas_empresa_data
  on public.vendas_negocio(empresa_id, data desc);
create index if not exists idx_vendas_cliente
  on public.vendas_negocio(cliente_id) where cliente_id is not null;
create index if not exists idx_vendas_vendedor
  on public.vendas_negocio(vendedor_id) where vendedor_id is not null;

-- ── ITENS DA VENDA ───────────────────────────────────────────────────
create table if not exists public.venda_itens (
  id          uuid primary key default gen_random_uuid(),
  venda_id    uuid not null references public.vendas_negocio(id) on delete cascade,
  produto_id  uuid references public.produtos_negocio(id) on delete set null,
  -- Nome CONGELADO: se o produto for renomeado ou arquivado, a venda antiga
  -- continua legível ("2× Bolo de cenoura"), não vira "produto removido".
  nome        text not null,
  quantidade  numeric(12,3) not null default 1,
  preco_unit  integer not null default 0,   -- CENTAVOS no momento da venda
  custo_unit  integer not null default 0,   -- CENTAVOS no momento da venda
  subtotal    integer not null default 0,   -- CENTAVOS (quantidade × preço)
  created_at  timestamptz not null default now()
);

create index if not exists idx_venda_itens_venda on public.venda_itens(venda_id);
-- "produtos mais vendidos" e "lucro por produto" varrem por aqui.
create index if not exists idx_venda_itens_produto
  on public.venda_itens(produto_id) where produto_id is not null;

-- ── Vínculo da venda no lançamento (o caminho inverso) ───────────────
alter table public.lancamentos_negocio
  add column if not exists venda_id uuid references public.vendas_negocio(id) on delete set null;

create index if not exists idx_lancamentos_venda
  on public.lancamentos_negocio(venda_id) where venda_id is not null;

-- ── RLS: escrita/leitura pelo backend (service role), como o resto do app ──
alter table public.clientes_negocio enable row level security;
alter table public.produtos_negocio enable row level security;
alter table public.vendas_negocio   enable row level security;
alter table public.venda_itens      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['clientes_negocio','produtos_negocio','vendas_negocio','venda_itens'] loop
    if not exists (select 1 from pg_policies
        where schemaname='public' and tablename=t and policyname = t || '_service_role') then
      execute format(
        'create policy %I on public.%I for all to service_role using (true) with check (true)',
        t || '_service_role', t);
    end if;
  end loop;
end $$;
