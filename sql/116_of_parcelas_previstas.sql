-- =============================================================================
-- 116 — Parcelas A VENCER que o banco conhece e a Sora não.
--
-- POR QUE ESTA TABELA EXISTE
-- A fatura de setembro de um cliente saía R$ 282,27 onde o app do banco mostrava
-- R$ 558,78. Os R$ 276,51 de diferença eram três parcelas (Prosed, PayU Adidas,
-- Chinoca) que só existem no endpoint `parcelamentos` da Polp: o Mercado Pago
-- manda parcela SEM o marcador "N/M" na descrição, e é dele que a redistribuição
-- do sync depende — sem marcador, a 2ª parcela nunca vira transação.
--
-- ⚠️ ISTO NÃO É HISTÓRICO, É PROJEÇÃO. A cada sync as linhas do cartão são
-- apagadas e regravadas. E de propósito NÃO vira transação: já existiu uma
-- `sql/078` só pra limpar parcela futura que tinha sido importada como gasto em
-- 2027. Projeção errada aqui some no sync seguinte; em `transacoes` viraria lixo
-- no histórico do usuário.
--
-- Precisa existir porque `GET /api/wallets/faturas/:phone` lê o banco — os
-- `parcelamentos` só chegam durante o sync, e não dá pra chamar a Polp toda vez
-- que alguém abre a tela do cartão.
--
-- Idempotente.
-- =============================================================================

create table if not exists of_parcelas_previstas (
  id            uuid primary key default gen_random_uuid(),
  grupo_id      uuid not null references grupos(id) on delete cascade,
  cartao_id     uuid not null references wallets(id) on delete cascade,
  competencia   text not null,              -- 'YYYY-MM' do VENCIMENTO da fatura
  descricao     text,
  valor         numeric(12,2) not null,
  parcela_num   int  not null,
  parcela_total int  not null,
  -- Estável entre syncs: instante da compra + nº de parcelas + valor. É a chave
  -- de dedup (a Polp manda a MESMA compra duas vezes, com 1 centavo e descrição
  -- diferentes — casar por descrição não pega).
  assinatura    text not null,
  created_at    timestamptz default now()
);

-- A leitura é sempre "as parcelas da fatura X do cartão Y".
create index if not exists idx_parcelas_previstas_cartao
  on of_parcelas_previstas (cartao_id, competencia);
create index if not exists idx_parcelas_previstas_grupo
  on of_parcelas_previstas (grupo_id);

-- Uma linha por parcela de cada compra, por cartão. Se o sync rodar duas vezes
-- em paralelo, o upsert não duplica.
create unique index if not exists uq_parcelas_previstas
  on of_parcelas_previstas (cartao_id, assinatura, parcela_num);

-- ── RLS: leitura/escrita pelo backend (service role), como o resto do app ──
alter table public.of_parcelas_previstas enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
      and tablename = 'of_parcelas_previstas'
      and policyname = 'of_parcelas_previstas_service_role') then
    create policy of_parcelas_previstas_service_role
      on public.of_parcelas_previstas for all to service_role
      using (true) with check (true);
  end if;
end $$;
