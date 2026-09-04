-- =============================================================================
-- 156 — plano `gratis`: o modo manual, de graça, só no painel.
--
-- A Sora era paga desde o primeiro minuto: quem criava conta nascia `inativo` e
-- o `PaywallRedirect` mandava TODA rota pro /planos — inclusive o onboarding.
-- Medido antes da mudança: 165 usuários, 73 (44%) em `inativo` e 68 (41%) que
-- nunca concluíram o onboarding. Quase metade da base parada numa porta fechada.
--
-- `gratis` = o painel do Básico MENOS WhatsApp, Saúde, Open Finance, Drive,
-- Wrapped, Agenda e Agentes. Lança à mão, sem pagar, sem prazo.
--
-- ⚠️ NÃO É A MESMA COISA QUE `inativo`, e a separação é deliberada:
--   · `inativo` = paywall (nunca pagou ou cancelou) → não entra no app;
--   · `gratis`  = usa o app, limitado pelos gates de feature.
-- Juntar os dois faria o /admin contar como cancelamento quem nunca pagou, e
-- MRR e churn passariam a mentir.
--
-- ⚠️ ESTA MIGRATION É OBRIGATÓRIA, E A FALHA É SILENCIOSA. O `users_plano_check`
-- recusa qualquer valor fora da lista, e o UPDATE que grava o plano não lê o
-- erro: sem rodar isto, `plano='gratis'` simplesmente não entra e o usuário
-- fica `inativo` pra sempre — de novo. É a mesma pegadinha registrada nas
-- migrations 061 (kit), 121 (tipo de investimento), 125 (consórcio) e 142
-- (platinum).
-- =============================================================================

alter table public.users drop constraint if exists users_plano_check;

alter table public.users
  add constraint users_plano_check
  check (plano in ('inativo', 'gratis', 'basico', 'kit', 'premium', 'platinum'));

comment on column public.users.plano is
  'inativo (paywall) · gratis (modo manual, sem WhatsApp) · basico · kit (vitalício sem WhatsApp) · premium · platinum. Espelhado em lib/plans.ts e src/config/planos.js.';

-- ⚠️ OS 73 `inativo` DE HOJE NÃO SÃO CONVERTIDOS AQUI, de propósito. Entre eles
-- há quem nunca pagou E quem cancelou, e a conversão em massa apagaria essa
-- diferença justo no mês em que ela passa a ser medida. A reativação da base é
-- uma decisão à parte, depois que o modo grátis estiver no ar.
