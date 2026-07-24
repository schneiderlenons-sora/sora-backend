-- =====================================================================
-- 096 — Pagamento parcial da fatura + rollover do saldo (rotativo SEM juros)
--
-- Cliente pediu: pagar PARTE da fatura do cartão e o que sobrar rolar pra
-- próxima fatura (como nos bancos), SEM juros.
--
-- Hoje "pagar fatura" só criava um débito na conta e marcava pago num
-- localStorage — não guardava QUANTO foi pago nem rolava o saldo.
--
-- Duas tabelas:
--   • pagamentos_fatura — cada pagamento (parcial permitido) por cartão +
--     competência (mês 'YYYY-MM'). restante = fatura do mês − soma dos pagamentos.
--   • fatura_rollover   — ciclo de vida do "sobrou X, rola pra próxima":
--     no vencimento vira 'aguardando' (avisa no WhatsApp, 24h pra confirmar);
--     confirmou OU passou 24h → materializa e vira 'rolado'.
--
-- Só cartões MANUAIS (Open Finance já traz a fatura real do banco).
-- Aplicar: Supabase → SQL Editor → Run. Idempotente.
-- =====================================================================

create table if not exists public.pagamentos_fatura (
  id            uuid primary key default gen_random_uuid(),
  grupo_id      uuid not null references public.grupos(id) on delete cascade,
  user_id       uuid references public.users(id) on delete set null,
  cartao_id     uuid not null references public.wallets(id) on delete cascade,
  competencia   text not null,                 -- 'YYYY-MM' (mês da fatura paga)
  valor         numeric(12,2) not null,        -- REAIS (mesma unidade de transacoes.valor)
  data          date not null default current_date,
  transacao_id  uuid references public.transacoes(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_pag_fatura_cartao_comp
  on public.pagamentos_fatura(cartao_id, competencia);

create table if not exists public.fatura_rollover (
  id                     uuid primary key default gen_random_uuid(),
  grupo_id               uuid not null references public.grupos(id) on delete cascade,
  user_id                uuid references public.users(id) on delete set null,
  cartao_id              uuid not null references public.wallets(id) on delete cascade,
  competencia            text not null,        -- fatura de ORIGEM (a que ficou devendo)
  valor                  numeric(12,2) not null, -- REAIS que rolaram
  status                 text not null default 'aguardando'
                           check (status in ('aguardando','rolado','cancelado')),
  avisado_em             timestamptz,
  confirmar_ate          timestamptz,          -- agora + 24h; passou → rola sozinho
  rolado_em              timestamptz,
  transacao_rollover_id  uuid references public.transacoes(id) on delete set null,
  created_at             timestamptz not null default now(),
  unique (cartao_id, competencia)              -- 1 rollover por fatura (dedup)
);

create index if not exists idx_rollover_status
  on public.fatura_rollover(status, confirmar_ate);
