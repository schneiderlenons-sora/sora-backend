-- =====================================================================
-- 107 — Estoque, fornecedores e compras (Sora Negócios, fase 3)
--
-- Pra comércio, o estoque costuma ser o maior ativo — e o mais mal controlado.
-- Também é o módulo que mais destrói confiança se der número errado: se o
-- saldo mente uma vez, o dono nunca mais olha.
--
-- DECISÕES:
--
-- 1. ESTOQUE É LIVRO-RAZÃO, NÃO UM CAMPO. Cada entrada/saída é uma linha em
--    `estoque_movimentos`; o saldo é a SOMA delas. Um campo `saldo` no produto
--    seria mais rápido de ler e impossível de auditar: quando divergisse — e
--    diverge, com venda cancelada, edição, erro de rede — não haveria como
--    saber de onde veio o número. Aqui sempre dá pra reconstruir e provar.
--
-- 2. CUSTO MÉDIO MÓVEL, atualizado a cada ENTRADA:
--       novo = (saldo × custo_atual + qtd × custo_compra) / (saldo + qtd)
--    Sem isso, "lucro por produto" é chute: comprei a 10, depois a 14, vendi a
--    20 — a margem real depende de quanto custou o que saiu. É a convenção que
--    o contador brasileiro usa e a que o Simples aceita.
--    ⚠️ SAÍDA não mexe no custo médio (só consome saldo). Recalcular na saída
--    é o erro clássico que faz o custo derreter a cada venda.
--
-- 3. COMPRA GERA CONTA A PAGAR. Igual venda→recebível: o pedido ao fornecedor
--    vira `lancamentos_negocio` de saída (pendente se for a prazo). Uma fonte
--    de dinheiro só.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

-- ── FORNECEDORES ─────────────────────────────────────────────────────
create table if not exists public.fornecedores_negocio (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  nome       text not null,
  telefone   text,
  email      text,
  documento  text,
  observacao text,
  ativo      boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_fornecedores_empresa
  on public.fornecedores_negocio(empresa_id) where ativo;

-- ── COMPRAS (pedido ao fornecedor) ───────────────────────────────────
create table if not exists public.compras_negocio (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  fornecedor_id uuid references public.fornecedores_negocio(id) on delete set null,
  fornecedor_nome text,
  data          date not null default (now() at time zone 'America/Sao_Paulo')::date,
  total         integer not null default 0,   -- CENTAVOS
  status        text not null default 'recebida'
                check (status in ('pedida', 'recebida', 'cancelada')),
  -- Só quando RECEBIDA o estoque entra: mercadoria pedida e não entregue não
  -- pode aparecer como disponível pra vender.
  recebida_em   date,
  vencimento    date,
  observacao    text,
  lancamento_id uuid references public.lancamentos_negocio(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_compras_empresa_data
  on public.compras_negocio(empresa_id, data desc);

create table if not exists public.compra_itens (
  id         uuid primary key default gen_random_uuid(),
  compra_id  uuid not null references public.compras_negocio(id) on delete cascade,
  produto_id uuid references public.produtos_negocio(id) on delete set null,
  nome       text not null,                  -- congelado, igual venda_itens
  quantidade numeric(12,3) not null default 1,
  custo_unit integer not null default 0,     -- CENTAVOS pagos nesta compra
  subtotal   integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_compra_itens_compra on public.compra_itens(compra_id);

-- ── MOVIMENTOS DE ESTOQUE (o livro-razão) ────────────────────────────
create table if not exists public.estoque_movimentos (
  id         uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references public.empresas(id) on delete cascade,
  produto_id uuid not null references public.produtos_negocio(id) on delete cascade,
  -- entrada: compra, ajuste pra cima, devolução de cliente
  -- saida:   venda, perda/quebra, ajuste pra baixo
  tipo       text not null check (tipo in ('entrada', 'saida')),
  motivo     text not null default 'ajuste'
             check (motivo in ('compra', 'venda', 'ajuste', 'perda', 'devolucao')),
  quantidade numeric(12,3) not null,          -- sempre POSITIVA; `tipo` dá o sinal
  custo_unit integer not null default 0,      -- CENTAVOS no momento
  -- Origem, pra rastrear e desfazer: venda cancelada devolve ao estoque.
  venda_id   uuid references public.vendas_negocio(id) on delete set null,
  compra_id  uuid references public.compras_negocio(id) on delete set null,
  observacao text,
  data       date not null default (now() at time zone 'America/Sao_Paulo')::date,
  created_at timestamptz not null default now()
);

-- Saldo de um produto = varredura por aqui; tem de ser barato.
create index if not exists idx_estoque_produto
  on public.estoque_movimentos(produto_id, created_at desc);
create index if not exists idx_estoque_empresa_data
  on public.estoque_movimentos(empresa_id, data desc);
create index if not exists idx_estoque_venda
  on public.estoque_movimentos(venda_id) where venda_id is not null;

-- ── Produto: saldo materializado + controle opcional ─────────────────
-- O livro-razão continua sendo a VERDADE; estas colunas são cache pra listar
-- 300 produtos sem 300 varreduras. Divergiu? recalcula pelos movimentos.
alter table public.produtos_negocio
  add column if not exists estoque_atual numeric(12,3) not null default 0;

-- Nem todo produto tem controle de estoque (serviço, ou item que o dono não
-- quer controlar). Sem esta flag, "produtos sem estoque" polui todo alerta.
alter table public.produtos_negocio
  add column if not exists controla_estoque boolean not null default false;

-- Vínculo compra → conta a pagar (o caminho inverso).
alter table public.lancamentos_negocio
  add column if not exists compra_id uuid references public.compras_negocio(id) on delete set null;

-- ── RLS ──────────────────────────────────────────────────────────────
alter table public.fornecedores_negocio enable row level security;
alter table public.compras_negocio      enable row level security;
alter table public.compra_itens         enable row level security;
alter table public.estoque_movimentos   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['fornecedores_negocio','compras_negocio','compra_itens','estoque_movimentos'] loop
    if not exists (select 1 from pg_policies
        where schemaname='public' and tablename=t and policyname = t || '_service_role') then
      execute format(
        'create policy %I on public.%I for all to service_role using (true) with check (true)',
        t || '_service_role', t);
    end if;
  end loop;
end $$;
