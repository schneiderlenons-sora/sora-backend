-- =============================================================================
-- 185 — Restitui a conexão ANUAL paga pelo davidson.clynton@gmail.com.
--
-- MESMO caso do gilbertojun (migration 180), medido no Stripe LIVE em 11/10/2026:
--   · 19/09: invoice `subscription_create` R$ 60,00 PAGA, qty 1, período
--     2026-09-19 → 2027-09-19. Ou seja, pagou 1 conexão ANUAL (R$60/conexão/ano).
--   · 25/09: tentou subir pra 2 conexões; a proration da diferença (R$ 58,91)
--     FICOU EM ABERTO e falhou.
--   · 09/10: o Stripe cancelou a assinatura por "payment_failed" — e o webhook
--     `customer.subscription.deleted` ZEROU `of_conexoes_pagas`, levando junto a
--     conexão que ele JÁ TINHA PAGO.
--   · 10/10: o JOB 1R viu limite 0 (vitalício, franquia 0) com 2 conexões vivas
--     (Banco do Brasil + CAIXA) e mandou o aviso de 3 dias.
--
-- A RAIZ foi corrigida no webhook (lib/conexao-of-encerramento): daqui pra frente
-- o cancelamento de uma conexão ANUAL mantém o que foi pago até o fim do período.
-- Mas o evento do davidson já passou (não virá outro do Stripe), então o dado
-- precisa ser restaurado à mão — como foi com o gilberto na 180.
--
-- ⚠️ RESTAURA 1, NÃO 2. Ele pagou 1 conexão; a 2ª (a proration) falhou e nunca
-- foi paga. Com of_conexoes_pagas = 1 ele fica com limite 1 e 2 conexões vivas,
-- então segue 1 ACIMA do direito — o que é correto: precisa pagar a 2ª (R$6/mês
-- ou R$60/ano) ou desconectar um banco. Se o dono quiser dar a 2ª de cortesia, é
-- decisão de negócio: subir pra 2 aqui e somar +1 ano em of_conexoes_pagas_ate.
--
-- ⚠️ Limpa of_excedente_desde/of_excedente_avisado: o aviso que ele recebeu dizia
-- "2 bancos serão desligados" (errado — só 1 está fora do direito). Zerando as
-- marcas, o JOB 1R reavalia do zero e, se ainda houver excedente de 1, reinicia o
-- prazo de 72h com a mensagem correta.
--
-- Idempotente e ESTREITO: só grava se ainda estiver zerado e sem prazo. Se ele
-- reassinar no Stripe, o webhook reescreve of_conexoes_pagas e esta migration não
-- atropela.
-- =============================================================================

update public.users
   set of_conexoes_pagas     = 1,
       of_conexoes_pagas_ate = timestamptz '2027-09-19 00:00:00-03',
       of_excedente_desde    = null,
       of_excedente_avisado  = null
 where email = 'davidson.clynton@gmail.com'
   and coalesce(of_conexoes_pagas, 0) = 0
   and of_conexoes_pagas_ate is null;

-- Conferência:
--   select email, plano, vitalicio, of_conexoes_pagas, of_conexoes_pagas_ate,
--          of_excedente_desde
--     from users where email = 'davidson.clynton@gmail.com';
