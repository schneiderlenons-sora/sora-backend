-- =====================================================================
-- 023 — Metadata de cartões de crédito
-- Adiciona campos pra gestão de fatura (limite, dias) e cosméticos
-- (bandeira, últimos 4 dígitos) direto na tabela wallets.
-- Antes ficavam em localStorage do frontend — agora persistem.
-- Idempotente.
-- =====================================================================

alter table public.wallets
  add column if not exists limite         numeric(12, 2),
  add column if not exists dia_fechamento smallint check (dia_fechamento between 1 and 28),
  add column if not exists dia_vencimento smallint check (dia_vencimento between 1 and 28),
  add column if not exists bandeira       text
    check (bandeira in ('Visa', 'Mastercard', 'Elo', 'Amex', 'Hipercard')),
  add column if not exists ultimos4       text check (length(ultimos4) <= 4);

-- =====================================================================
-- Verificação:
--   select nome, tipo, limite, dia_fechamento, dia_vencimento, bandeira
--     from public.wallets where tipo = 'Crédito' limit 5;
-- =====================================================================

-- =====================================================================
-- Atualiza o CHECK de transacoes_pendentes.tipo_pergunta pra aceitar
-- os novos tipos do wizard (criar_cartao e tipo_conta).
-- =====================================================================

alter table public.transacoes_pendentes
  drop constraint if exists transacoes_pendentes_tipo_pergunta_check;

alter table public.transacoes_pendentes
  add constraint transacoes_pendentes_tipo_pergunta_check
  check (tipo_pergunta in (
    'escolher_conta',
    'marcar_principal',
    'criar_conta',
    'criar_cartao',
    'tipo_conta'
  ));
