-- =====================================================================
-- 100 — Dívidas vindas do Open Finance (empréstimos e financiamentos)
--
-- O trilho Celcoin (API v2 da Polp) traz contrato de empréstimo/financiamento
-- com saldo devedor real, parcelas pagas e CET. Esses contratos entram na aba
-- **Dívidas** do painel, então a tabela precisa das mesmas 3 colunas que
-- `investimentos` ganhou na 069: id externo (pra dedup), provedor e origem.
--
-- Sem o `of_id` único, cada sincronização criaria a dívida de novo (o sync roda
-- 1×/dia por contrato).
--
-- `origem`:
--   'manual' → o usuário cadastrou na mão (comportamento atual, default)
--   'of'     → importado do Open Finance (não editar valor/parcelas na mão:
--              o banco é a fonte e o sync sobrescreve)
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.dividas add column if not exists of_id       text;
alter table public.dividas add column if not exists of_provider text;
alter table public.dividas add column if not exists origem      text default 'manual';

-- Dedup: 1 dívida por contrato do provedor. Parcial (só quando of_id existe),
-- pra não conflitar com as dívidas manuais (que têm of_id null).
create unique index if not exists uq_dividas_of
  on public.dividas(of_id) where of_id is not null;

create index if not exists idx_dividas_origem on public.dividas(origem);
