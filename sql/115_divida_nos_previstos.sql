-- =====================================================================
-- 115 — Dívida entra (ou não) nos "Previstos do mês".
--
-- A parcela de uma dívida É um gasto previsto do mês, igual à luz ou ao
-- aluguel — mas até agora o card de Previstos só olhava `recorrencias`, então
-- quem tem financiamento via um total de previstos menor do que a realidade.
--
-- Esta coluna é o "não quero contar esta dívida aí". Sai do card de Previstos
-- e para de somar no total, MAS a dívida continua intacta na aba Dívidas —
-- com o histórico de pagamentos, os lembretes e o saldo devedor. É o oposto de
-- excluir: some da PREVISÃO, não do controle.
--
-- Default `true`: quem já tem dívida cadastrada passa a ver a parcela no card
-- automaticamente, que é o comportamento correto (era o que faltava).
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.dividas
  add column if not exists nos_previstos boolean not null default true;

comment on column public.dividas.nos_previstos is
  'true = a parcela do mês aparece e soma no card "Previstos do mês" da aba Transações. false = o usuário tirou dali; a dívida segue normal na aba Dívidas. Ver sql/115.';

-- Conferência:
--   select titulo, valor_parcela, dia_vencimento, status, nos_previstos
--     from dividas where status in ('ativa','em_atraso');
