-- =============================================================================
-- 179 — Conexão de banco ALÉM do direito do plano: o relógio do aviso.
--
-- Medido em 02/10/2026: 9 contas usando 16 conexões de Open Finance além do que
-- o plano cobre. Cinco são VITALÍCIAS (franquia zero por decisão: pagou uma vez
-- e cada conexão nos custa mensalidade no agregador) e quatro estão `inativo`.
-- A maior usa 5 conexões com direito 0.
--
-- ⚠️ A CAUSA É ESTRUTURAL: a franquia só é checada ao CONECTAR. Cancelar a
-- assinatura da conexão avulsa zera `of_conexoes_pagas` (webhook do Stripe) e
-- cair pra `inativo` zera a franquia — e as conexões seguem vivas e cobradas.
-- Nada no sistema reavaliava isso depois.
--
-- A regra (decisão do dono, 02/10/2026) é AVISAR E DAR 2 DIAS, nunca cortar na
-- hora. Estas duas colunas são o que torna o prazo honesto:
--
--   of_excedente_desde    — quando o excedente foi detectado pela PRIMEIRA vez.
--                           O prazo conta daqui. NULL = não está excedendo (ou
--                           regularizou, e aí o cron apaga o marco).
--   of_excedente_avisado  — dedup do aviso no WhatsApp, à prova de restart.
--                           Sem ela o cron de 15 min avisaria 96 vezes por dia.
--
-- ⚠️ O MARCO NUNCA É RETROATIVO. Mesmo quem está nessa situação há meses recebe
-- os 2 dias inteiros a partir do primeiro aviso de verdade — é por isso que o
-- prazo mora numa coluna e não é derivado de `created_at` da conexão.
--
-- ⚠️ SEM ELA NADA QUEBRA: todas as leituras são separadas e tolerantes. Sem as
-- colunas, o cron não encontra ninguém e a tela não mostra aviso — ou seja, o
-- comportamento volta a ser exatamente o de hoje.
-- =============================================================================

alter table public.users
  add column if not exists of_excedente_desde   timestamptz,
  add column if not exists of_excedente_avisado timestamptz;

comment on column public.users.of_excedente_desde is
  'Quando este usuário passou a ter mais conexões de Open Finance do que o plano cobre. O prazo de regularização (48h) conta desta data. NULL = dentro do direito.';

comment on column public.users.of_excedente_avisado is
  'Último aviso de excedente enviado no WhatsApp. Dedup à prova de restart.';

-- Quem está nessa situação agora (o cron preenche; esta é a consulta de conferência):
--   select email, plano, vitalicio, of_conexoes_pagas,
--          of_excedente_desde, of_excedente_desde + interval '48 hours' as prazo
--     from users where of_excedente_desde is not null
--    order by of_excedente_desde;
