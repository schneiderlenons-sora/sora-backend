-- =============================================================================
-- 183 — Quando a assinatura da conexão de banco termina, e o aviso prévio.
--
-- Decisão do dono (out/2026), depois de medir: a Polp cobra por CONSENTIMENTO
-- ATIVO, não por uso — então pausar o sync não para a conta. Só cortar resolve.
-- Mas cortar sem aviso é o que fez o corte ser desligado (`OF_EXCEDENTE_CORTAR=0`).
--
-- O desenho passou a ter TRÊS estágios, e estas colunas são o que os sustenta:
--
--   1. AVISO PRÉVIO — a pessoa cancelou e o período ainda corre. O Stripe sabe
--      disso (`cancel_at_period_end` + `current_period_end`) e manda no webhook
--      `customer.subscription.updated`. Guardamos a data em
--      `of_assinatura_fim` e avisamos 3 DIAS ANTES: "sua conexão com o banco
--      termina em X". É o único momento em que dá pra agir sem perder nada.
--
--   2. PRAZO — terminou o período, mas o banco segue conectado por 3 dias.
--      Quem continua é `of_excedente_desde` (migration 179), com o prazo
--      esticado de 48h para 72h.
--
--   3. CORTE — passados os 3 dias, o consentimento é revogado. É o que para a
--      cobrança da Polp.
--
-- ⚠️ `of_assinatura_fim` NÃO é o mesmo que `of_conexoes_pagas_ate` (migration
-- 180). Aquela diz "este período pago vale até", e é usada pra conceder acesso.
-- Esta diz "a assinatura vai acabar nesta data", e é usada pra AVISAR. Uma
-- concede, a outra alerta — misturá-las faria o aviso virar permissão.
--
-- ⚠️ SEM ELA NADA QUEBRA: o webhook grava num try/catch próprio, o cron lê numa
-- consulta tolerante e, sem a coluna, simplesmente não há aviso prévio — o
-- fluxo cai no estágio 2, que é o comportamento de hoje.
-- =============================================================================

alter table public.users
  add column if not exists of_assinatura_fim    timestamptz,
  add column if not exists of_fim_avisado_em    timestamptz;

comment on column public.users.of_assinatura_fim is
  'Quando a assinatura da conexão de Open Finance termina (o `current_period_end` do Stripe, gravado quando a pessoa marca o cancelamento). Serve para AVISAR 3 dias antes — não concede acesso.';

comment on column public.users.of_fim_avisado_em is
  'Último aviso de "sua conexão vai terminar" enviado. Dedup à prova de restart.';

-- Conferência:
--   select email, of_assinatura_fim, of_fim_avisado_em
--     from users where of_assinatura_fim is not null order by of_assinatura_fim;
