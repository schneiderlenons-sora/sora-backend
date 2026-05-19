-- =====================================================================
-- 010 — Controle de dívidas (empréstimos, financiamentos, crediário, etc.)
-- Idempotente.
-- =====================================================================

create table if not exists public.dividas (
  id              uuid primary key default gen_random_uuid(),
  grupo_id        uuid not null references public.grupos(id) on delete cascade,
  criado_por      uuid references public.users(id) on delete set null,
  titulo          text not null,
  credor          text,                -- banco/loja/instituicao
  tipo            text not null default 'emprestimo'
                    check (tipo in ('emprestimo','financiamento','crediario','cartao_rotativo','cheque_especial','consignado','fies','outro')),
  valor_total     numeric(12,2) not null check (valor_total > 0),
  valor_parcela   numeric(12,2),
  parcelas_total  int,
  parcelas_pagas  int not null default 0,
  taxa_juros      numeric(8,4),        -- % ao mes
  indexador       text,                -- pre, cdi, ipca, selic
  dia_vencimento  int check (dia_vencimento between 1 and 31),
  data_inicio     date,
  data_quitacao   date,
  status          text not null default 'ativa'
                    check (status in ('ativa','quitada','em_atraso','renegociada','suspensa')),
  observacao      text,
  created_at      timestamp default now(),
  updated_at      timestamp default now()
);

create table if not exists public.divida_pagamentos (
  id              uuid primary key default gen_random_uuid(),
  divida_id       uuid not null references public.dividas(id) on delete cascade,
  user_id         uuid references public.users(id) on delete set null,
  numero_parcela  int,                  -- 1, 2, 3...
  valor           numeric(12,2) not null check (valor > 0),
  tipo            text not null default 'parcela'
                    check (tipo in ('parcela','antecipacao','juros_atraso','quitacao')),
  data_pagamento  date not null default current_date,
  observacao      text,
  created_at      timestamp default now()
);

create index if not exists idx_dividas_grupo       on public.dividas(grupo_id, status);
create index if not exists idx_dividas_vencimento  on public.dividas(grupo_id, dia_vencimento) where status = 'ativa';
create index if not exists idx_pagamentos_divida   on public.divida_pagamentos(divida_id, data_pagamento desc);
