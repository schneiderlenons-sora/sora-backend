-- =====================================================================
-- 037 — Tipo de pendente 'descontar_destino'
--
-- Quando o usuário faz um aporte/pagamento pelo WhatsApp (meta, investimento,
-- dívida ou fatura), a Sora pergunta se quer descontar de uma conta e lista
-- as contas. A resposta é resolvida por este tipo de pendente.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
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
    'tipo_conta',
    'pagar_parcela_conta',
    'descontar_destino'
  ));
