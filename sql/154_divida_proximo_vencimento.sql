-- =============================================================================
-- 154 — `dividas.proximo_vencimento`: a data que o BANCO informa.
--
-- RELATO DE ORIGEM: "a próxima parcela do empréstimo vence dia 06 de OUTUBRO,
-- mas o app diz 06 de setembro".
--
-- O card derivava a próxima parcela de `dia_vencimento` + calendário: "a
-- próxima ocorrência do dia 6 que ainda não passou". Isso é o melhor que dá
-- pra fazer numa dívida lançada à mão, mas é ERRADO na dívida do Open Finance,
-- onde o banco sabe o cronograma e a Sora não registra pagamento nenhum (as
-- pagas chegam como CONTAGEM, não como registro).
--
-- E o caso que quebra a derivação por calendário é justamente o mais comum em
-- empréstimo: ANTECIPAÇÃO. Quem adianta parcelas fica com a próxima lá na
-- frente, e o calendário continua apontando o mês que vem.
--
-- A coluna guarda a data derivada do cronograma do emissor
-- (`first_instalment_due_date` + `paid_instalments` meses). NULL em dívida
-- manual — lá a regra de calendário continua valendo, sem mudança nenhuma.
-- =============================================================================

alter table dividas add column if not exists proximo_vencimento date;

comment on column dividas.proximo_vencimento is
  'Vencimento da próxima parcela segundo o emissor (Open Finance). NULL em dívida manual, onde a data sai de dia_vencimento + calendário.';
