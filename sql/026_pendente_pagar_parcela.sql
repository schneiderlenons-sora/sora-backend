-- 026_pendente_pagar_parcela.sql
-- Adiciona o tipo 'pagar_parcela_conta' ao CHECK de transacoes_pendentes.
-- Usado quando a Sora pergunta de qual conta debitar ao antecipar parcelas.

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
    'pagar_parcela_conta'
  ));
