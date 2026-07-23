-- =============================================================================
-- 089_indices_performance.sql — índices das queries quentes do painel.
--
-- Item #3 do roadmap de performance (latência do backend). TODOS idempotentes
-- (IF NOT EXISTS) e ADITIVOS — seguros de rodar a qualquer momento no Supabase.
--
-- ⚠️ HONESTIDADE: no tamanho de dados atual as queries já voltam em ~58ms
-- (latência de rede, não de scan), então isto NÃO derruba os ~483ms medidos no
-- Render — esse custo é CPU do free tier + região. Estes índices são seguro de
-- ESCALA: quando o grupo tiver milhares de transações, o filtro grupo_id+data
-- continua instantâneo em vez de virar seq scan.
--
-- Postgres NÃO indexa colunas de FK automaticamente — por isso vários abaixo.
-- =============================================================================

-- TRANSACOES — a tabela mais quente. Todo resumo/lista/dashboard filtra por
-- grupo_id + range de data e ordena por data desc. Índice composto cobre isso.
create index if not exists idx_transacoes_grupo_data
  on transacoes (grupo_id, data desc);

-- Filtro por membro do grupo (relatórios: criado_por) dentro do grupo.
create index if not exists idx_transacoes_grupo_criador
  on transacoes (grupo_id, criado_por);

-- CATEGORY_LIMITS — GET /api/limites: grupo_id + mes_referencia.
create index if not exists idx_category_limits_grupo_mes
  on category_limits (grupo_id, mes_referencia);

-- WALLETS — listadas por grupo em várias abas.
create index if not exists idx_wallets_grupo
  on wallets (grupo_id);

-- CATEGORIAS — grupo_id + ativa (a lista sempre filtra ativa = true).
create index if not exists idx_categorias_grupo_ativa
  on categorias (grupo_id, ativa);

-- DIVIDAS — listadas por grupo, ordenadas por created_at desc.
create index if not exists idx_dividas_grupo_created
  on dividas (grupo_id, created_at desc);

-- DIVIDA_PAGAMENTOS — buscados por divida_id.
create index if not exists idx_divida_pagamentos_divida
  on divida_pagamentos (divida_id);

-- METAS — listadas por grupo.
create index if not exists idx_metas_grupo
  on metas (grupo_id);
