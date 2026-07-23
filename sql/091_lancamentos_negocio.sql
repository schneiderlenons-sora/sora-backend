-- =============================================================================
-- 091_lancamentos_negocio.sql — o LIVRO CAIXA do negócio (fase 2)
--
-- Uma tabela só resolve TRÊS coisas, porque "conta a pagar" nada mais é que uma
-- saída ainda não paga com data de vencimento:
--   • entrada  + status 'pago'      → venda do balcão (caixa)
--   • saída    + status 'pago'      → despesa já paga
--   • saída    + status 'pendente'  → CONTA A PAGAR (fase 3, sem migration nova)
--
-- É o mesmo modelo que a Sora já usa em transações (`pago`) e dívidas —
-- consistência conceitual, menos código e menos bug.
--
-- Depende da 090 (tabela empresas). Idempotente.
-- =============================================================================

create table if not exists public.lancamentos_negocio (
  id              uuid primary key default gen_random_uuid(),
  empresa_id      uuid not null references public.empresas(id) on delete cascade,
  user_id         uuid not null references public.users(id)    on delete cascade,

  tipo            text not null check (tipo in ('entrada','saida')),
  -- Categoria é TEXTO LIVRE de propósito: o catálogo vive no frontend
  -- (lib/lancamentos.ts), então criar categoria nova não exige migration.
  categoria       text,
  descricao       text not null,
  valor           bigint not null,          -- centavos (padrão do módulo Negócios)
  data            date not null,            -- competência (dia do caixa)

  -- Conta a pagar/receber: pendente + vencimento. 'pago' é o padrão porque a
  -- venda do balcão já entra liquidada.
  status          text not null default 'pago' check (status in ('pago','pendente')),
  vencimento      date,
  pago_em         date,

  forma_pagamento text,                     -- dinheiro, pix, debito, credito, boleto…
  contraparte     text,                     -- cliente (entrada) ou fornecedor (saída)
  -- Fase 4 (folha): quando o lançamento é o pagamento de um funcionário.
  -- Sem FK ainda — a tabela funcionarios_negocio nasce na 092.
  funcionario_id  uuid,

  recorrente      boolean default false,
  recorrencia     text check (recorrencia in ('mensal','semanal','anual') or recorrencia is null),

  observacao      text,
  anexo_url       text,
  -- Conciliação opcional com a Sora Finance (mesma ideia de custos_negocio).
  transacao_id    uuid references public.transacoes(id) on delete set null,

  created_at      timestamptz default now()
);

-- Query quente: caixa da empresa por período (ordenado por dia).
create index if not exists idx_lanc_empresa_data
  on public.lancamentos_negocio(empresa_id, data desc);

-- Query da fase 3: contas em aberto por vencimento.
create index if not exists idx_lanc_empresa_status_venc
  on public.lancamentos_negocio(empresa_id, status, vencimento);

create index if not exists idx_lanc_user on public.lancamentos_negocio(user_id);
