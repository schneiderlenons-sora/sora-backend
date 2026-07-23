-- =============================================================================
-- 092_funcionarios_negocio.sql — quadro de pessoal + folha (fase 4)
--
-- Escopo SIMPLES por decisão do produto: registro de pagamento, SEM cálculo de
-- encargos CLT (INSS/FGTS/férias). Isso é deliberado — cálculo trabalhista
-- errado gera passivo pro usuário; se um dia entrar, vira feature própria.
--
-- "Pagar salário" NÃO cria estrutura nova: gera um lançamento de saída na
-- categoria 'folha' (lancamentos_negocio) com funcionario_id preenchido. Ou
-- seja, a folha já nasce dentro do caixa e do DRE.
--
-- Depende da 090 (empresas) e da 091 (lancamentos_negocio). Idempotente.
-- =============================================================================

create table if not exists public.funcionarios_negocio (
  id             uuid primary key default gen_random_uuid(),
  empresa_id     uuid not null references public.empresas(id) on delete cascade,
  user_id        uuid not null references public.users(id)    on delete cascade,

  nome           text not null,
  -- Foto: data URL (mesmo padrão da logo da empresa — crop no canvas, sem bucket)
  foto_url       text,
  cargo          text,
  vinculo        text not null default 'clt'
                 check (vinculo in ('clt','pj','diarista','estagio','outro')),

  salario        bigint not null default 0,   -- centavos
  -- Dia do mês em que o salário vence. Alimenta o lembrete na Agenda/briefing
  -- (evento VIRTUAL, sem criar linha por mês — igual dívidas e recorrências).
  dia_pagamento  int check (dia_pagamento between 1 and 31),
  pix            text,                        -- chave pra facilitar o pagamento

  ativo          boolean not null default true,
  observacao     text,
  created_at     timestamptz default now()
);

create index if not exists idx_func_empresa on public.funcionarios_negocio(empresa_id, ativo);
create index if not exists idx_func_user    on public.funcionarios_negocio(user_id);

-- Liga o pagamento (lançamento de saída, categoria 'folha') ao funcionário.
-- A coluna já existia na 091 sem FK — agora a tabela existe, então amarramos.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'lancamentos_negocio_funcionario_fkey'
       and conrelid = 'public.lancamentos_negocio'::regclass
  ) then
    alter table public.lancamentos_negocio
      add constraint lancamentos_negocio_funcionario_fkey
      foreign key (funcionario_id) references public.funcionarios_negocio(id)
      on delete set null;
  end if;
end $$;

create index if not exists idx_lanc_funcionario
  on public.lancamentos_negocio(funcionario_id);
