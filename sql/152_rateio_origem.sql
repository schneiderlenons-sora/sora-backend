-- =============================================================================
-- 152 — Rateio: guardar o que a divisão SUBSTITUIU (pra dar pra voltar atrás)
--
-- A 151 criou `rateio_grupo`, que amarra as partes entre si. Só que o rateio
-- SUBSTITUI a transação original — ela é apagada — e com isso a **categoria
-- original se perde**. Sem ela, "voltar ao normal" não consegue devolver o
-- lançamento como era: no máximo junta as partes e chuta uma categoria.
--
-- Esta coluna guarda o mínimo pra reconstruir com fidelidade:
--   { "categoria": "🛒 Mercado", "id_curto": "A1B2C3", "valor": 300 }
--
-- ⚠️ GRAVADA IGUAL EM TODAS AS PARTES, não só na primeira. Se ficasse só numa,
-- apagar aquela parte levaria junto a única cópia da origem e o desfazer
-- deixaria de funcionar pro resto do grupo.
--
-- ⚠️ CONTINUA SEM LINHA-PAI. Isto é um RÓTULO, igual ao `rateio_grupo`: não
-- entra em soma nenhuma, não é lido por dashboard, categorias, limites,
-- relatórios, fatura, Wrapped ou Previstos. A decisão da 151 segue valendo —
-- guardar a linha original de verdade faria os R$ 300 do supermercado virarem
-- R$ 600 em todos esses lugares.
--
-- ⚠️ Por que `id_curto` também: é o código que o usuário vê e usa pra falar da
-- transação no WhatsApp ("apaga a A1B2C3"). Devolver o lançamento com um código
-- novo quebraria essa referência.
--
-- Aditiva e idempotente. Sem ela o rateio continua funcionando (a rota grava sem
-- a coluna) e o desfazer também — só cai no fallback de escolher a categoria da
-- maior parte, em vez de restaurar a original.
--
-- Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =============================================================================

alter table public.transacoes
  add column if not exists rateio_origem jsonb;

comment on column public.transacoes.rateio_origem is
  'O que o rateio substituiu: {categoria, id_curto, valor} do lançamento original (migration 152). Rótulo apenas — NÃO entra em nenhuma soma. Existe pra o "voltar ao normal" devolver a categoria e o código originais. Gravada igual em TODAS as partes de propósito: se ficasse só na primeira, apagar essa parte levaria a única cópia.';
