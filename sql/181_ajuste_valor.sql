-- =============================================================================
-- 181 — Ajustar o VALOR de uma previsão, sem pular nem adiar.
--
-- Pedido do cliente (out/2026, vnsposito): "aquilo que é previsão no extrato,
-- ser possível alterar seu valor, pois previsões de contas contínuas podem ter
-- variação, como por exemplo plano de saúde, luz, combustível".
--
-- ⚠️ METADE JÁ EXISTIA E ESTAVA INALCANÇÁVEL. A coluna `previsao_ajustes.novo_valor`
-- existe, `GET /previstos/ocorrencias` já a devolve como `novoValor`, e o motor
-- do extrato já a respeita:
--     const valor = aj && aj.novoValor != null ? cent(aj.novoValor) : cent(r.valor);
-- O que faltava era PODER GRAVÁ-LA sozinha: `POST /previstos/ajuste` só aceita
-- `status` em ('pulado','movido'), então o valor só entrava de carona num pular
-- (que esconde a linha) ou num adiar (que exige data nova).
--
-- ⚠️ E O CHECK BARRA. Medido inserindo `status='valor'` na base real:
--     new row ... violates check constraint "previsao_ajustes_status_check"
-- Sem esta migration a gravação falha — mesma família do `users_plano_check`
-- (memória `project-plano-check-constraint`) e do `investimentos_tipo_check`.
--
-- ⚠️ O CHECK É RECRIADO COM TODOS OS VALORES JÁ EM USO. Recriar sem algum
-- invalidaria linhas existentes: a base tem 'pulado' e 'movido' hoje (25 linhas
-- só na conta do relato), e perdê-las devolveria ao extrato contas que a pessoa
-- tinha pulado de propósito.
--
-- ⚠️ SEM ELA NADA QUEBRA: pular e adiar seguem funcionando, e a rota passou a
-- LER o erro do upsert — quem tentar ajustar o valor recebe a recusa explicada,
-- em vez de a tela fechar dizendo que salvou (o defeito das migrations 121/147).
-- =============================================================================

alter table public.previsao_ajustes
  drop constraint if exists previsao_ajustes_status_check;

alter table public.previsao_ajustes
  add constraint previsao_ajustes_status_check
  check (status in ('pulado', 'movido', 'valor'));

comment on column public.previsao_ajustes.novo_valor is
  'Valor desta ocorrência, quando diferente do valor da regra. Com status=valor a previsão continua ABERTA e só muda de valor (conta contínua que variou: luz, plano de saúde, combustível).';

-- Conferência:
--   select status, count(*) from previsao_ajustes group by status;
