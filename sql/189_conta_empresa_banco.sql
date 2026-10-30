-- =====================================================================
-- 189 — Conta do banco (Open Finance) alimentando o caixa da EMPRESA.
--
-- Pedido (Robert, out/2026): a conta PJ conectada pelo Open Finance só
-- aparecia nas finanças pessoais. Agora uma conta da empresa (contas_negocio)
-- pode ser VINCULADA a uma carteira do banco, e as movimentações dela entram
-- no caixa (lancamentos_negocio) ligadas à transação de origem.
-- Regra em src/services/espelhoContaEmpresa.js (`npm run eval:espelho-empresa`).
--
-- O que muda pra quem já usa: NADA até alguém vincular uma conta. Todas as
-- colunas são novas, com padrão neutro; nenhum dado existente é reescrito.
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

-- Qual carteira do banco alimenta esta conta da empresa, e desde quando.
alter table public.contas_negocio
  add column if not exists wallet_id uuid references public.wallets(id) on delete set null;
alter table public.contas_negocio
  add column if not exists importar_desde date;

-- Uma carteira do banco alimenta no máximo UMA conta ativa: duas contas da
-- empresa (ou duas empresas) puxando a mesma conta do banco contariam o mesmo
-- dinheiro duas vezes.
create unique index if not exists uq_contas_negocio_wallet
  on public.contas_negocio(wallet_id) where wallet_id is not null and ativa;

-- De onde veio o lançamento: digitado ('manual') ou trazido do banco ('banco').
-- Lançamento do banco tem valor e data travados na tela (quem manda é o banco).
alter table public.lancamentos_negocio
  add column if not exists origem text not null default 'manual';
do $$ begin
  alter table public.lancamentos_negocio
    add constraint lancamentos_negocio_origem_check check (origem in ('manual', 'banco'));
exception when duplicate_object then null; end $$;

-- ⚠️ Cada transação do banco vira NO MÁXIMO UM lançamento — é o que impede o
-- sync por webhook e o vínculo, rodando na mesma hora, de duplicarem o caixa.
-- (Medido antes: nenhum lançamento da base tinha transacao_id preenchido.)
create unique index if not exists uq_lancamentos_negocio_transacao
  on public.lancamentos_negocio(transacao_id) where transacao_id is not null;
