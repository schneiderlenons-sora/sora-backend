-- =====================================================================
-- 111 — Conexões de Open Finance pagas à parte
--
-- Cada banco conectado tem custo MENSAL nosso no agregador. O plano dá uma
-- franquia (Básico 1, Premium 3) e o vitalício não dá nenhuma — quem pagou uma
-- vez não sustenta um custo que se repete todo mês.
--
-- Então a conexão avulsa vira uma assinatura PRÓPRIA no Stripe (R$ 6/mês ou
-- R$ 60/ano por conexão), separada do plano. Estas colunas guardam o resultado
-- dela, que é o que o gate lê.
--
-- POR QUE COLUNA SEPARADA E NÃO `stripe_subscription_id`:
-- o vitalício não tem assinatura de plano, mas o assinante recorrente TEM — e
-- ele pode contratar conexão extra também. Se as duas assinaturas dividissem a
-- mesma coluna, cancelar uma derrubaria a outra (o webhook grava por id).
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.users
  -- Quantas conexões o usuário PAGA hoje. É somada à franquia do plano.
  -- Zero = só a franquia. O webhook do Stripe é quem escreve aqui.
  add column if not exists of_conexoes_pagas integer not null default 0,
  -- Assinatura do add-on (separada da assinatura do plano).
  add column if not exists of_assinatura_id text,
  -- 'mensal' | 'anual' — só pra tela saber o que a pessoa contratou.
  add column if not exists of_assinatura_intervalo text;

comment on column public.users.of_conexoes_pagas is
  'Open Finance: conexões pagas à parte (R$6/mês cada). Somadas à franquia do plano. Escrito pelo webhook do Stripe.';

-- Quem paga add-on é minoria; índice parcial mantém a busca do webhook barata.
create index if not exists idx_users_of_assinatura
  on public.users(of_assinatura_id) where of_assinatura_id is not null;
