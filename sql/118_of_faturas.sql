-- =============================================================================
-- 118 — Faturas PUBLICADAS pelo banco (Open Finance)
--
-- POR QUE ESTA TABELA EXISTE
-- O emissor publica, por fatura: `due_date`, `bill_closing_date`,
-- `bill_total_amount` e `payments[]`. Isso é a VERDADE — é o número que o
-- cliente vê no app do banco. A Sora recebia tudo isso a cada sync e jogava
-- fora: guardava só o ID da fatura aberta (`wallets.of_bill_atual`) e
-- RECONSTRUÍA o valor somando as transações que tinha importado.
--
-- Reconstruir é frágil por natureza — depende de ter TODAS as transações, de
-- acertar o recorte do ciclo e de adivinhar parcela futura. Cada uma dessas
-- peças já falhou em produção:
--   · faltou transação    → fatura menor que a do banco (caso do relato:
--                           app R$ 1.035,55 × banco R$ 1.788,00);
--   · carteira duplicada  → transação contada duas vezes;
--   · parcela sem "N/M"   → parcela futura sumia da fatura.
-- Com a fatura publicada guardada, nada disso afeta o VALOR: ele passa a vir
-- pronto do banco, e a soma das transações vira só o fallback do ciclo que o
-- emissor ainda não publicou.
--
-- `competencia` = 'YYYY-MM' do VENCIMENTO — mesma convenção do resto do
-- projeto (services/cicloFatura.js, pagamentos_fatura, fatura_rollover).
--
-- ⚠️ NÃO é projeção nem cache descartável: é o extrato oficial. Por isso tem
-- `of_bill_id` único (upsert idempotente a cada sync) e guarda também as
-- DATAS reais da fatura, que hoje são inferidas por moda do dia do mês.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =============================================================================

create table if not exists public.of_faturas (
  id            uuid primary key default gen_random_uuid(),
  grupo_id      uuid not null references public.grupos(id)  on delete cascade,
  cartao_id     uuid not null references public.wallets(id) on delete cascade,
  -- ID da fatura na Polp. Chave natural do upsert.
  of_bill_id    text not null,
  competencia   text not null,              -- 'YYYY-MM' do VENCIMENTO
  vencimento    date,
  fechamento    date,
  total         numeric(12,2),
  pago          numeric(12,2) default 0,
  minimo        numeric(12,2),
  is_parcelada  boolean default false,
  atualizado_em timestamptz default now()
);

-- Upsert por fatura (o sync roda todo dia e não pode empilhar).
create unique index if not exists uq_of_faturas_bill
  on public.of_faturas (cartao_id, of_bill_id);

-- A leitura é sempre "a fatura da competência X deste cartão".
create index if not exists idx_of_faturas_comp
  on public.of_faturas (cartao_id, competencia);
create index if not exists idx_of_faturas_grupo
  on public.of_faturas (grupo_id);

-- ── RLS: leitura/escrita pelo backend (service role), como o resto do app ──
alter table public.of_faturas enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public'
      and tablename = 'of_faturas' and policyname = 'of_faturas_service_role') then
    create policy of_faturas_service_role
      on public.of_faturas for all to service_role
      using (true) with check (true);
  end if;
end $$;
