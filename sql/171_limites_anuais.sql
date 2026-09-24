-- =====================================================================
-- 171 — Limites ANUAIS (teto por categoria + teto geral do ano)
--
-- Pedido de cliente (set/2026): "limites mensais e anuais — o de vocês é
-- somente mensal". Gasto sazonal (IPVA, seguro, viagem, presentes) estoura
-- um mês e cabe no ano; só com teto mensal não há como planejar isso.
--
-- ⚠️ O TETO ANUAL REUSA `category_limits` — sem tabela nova e SEM mexer na
-- unique `(grupo_id, categoria, mes_referencia)`. A chave do ano é o PRÓPRIO
-- `mes_referencia` guardando só o ano ('2026' em vez de '2026-09'): '2026' e
-- '2026-09' são strings diferentes, então a constraint já os separa e um
-- limite mensal e um anual da MESMA categoria convivem sem colidir.
--
-- ⚠️ `periodo` é EXPLÍCITO de propósito. Dava pra deduzir pelo tamanho do
-- texto (4 = ano, 7 = mês), mas regra implícita em coluna de texto livre é o
-- tipo de coisa que quebra calada quando alguém gravar '2026-1'.
--
-- ⚠️ `limite_mensal` continua com esse NOME guardando o teto dos dois casos.
-- Renomear exigiria tocar em toda query de limite (rotas, handler do zap,
-- serviço de alerta e painel) — risco alto por ganho cosmético. Leia como
-- "o teto daquela linha".
--
-- Idempotente.
-- =====================================================================

-- ── Teto por CATEGORIA ───────────────────────────────────────────────
alter table public.category_limits
  add column if not exists periodo text default 'mensal';

update public.category_limits set periodo = 'mensal' where periodo is null;

-- Recriado sempre: se um dia entrar 'semanal', esta é a linha a mexer.
-- ⚠️ Mesma família do `users_plano_check` e do `investimentos_tipo_check` —
-- valor novo na aplicação que não esteja aqui faz a gravação falhar CALADA.
alter table public.category_limits
  drop constraint if exists category_limits_periodo_check;
alter table public.category_limits
  add constraint category_limits_periodo_check
  check (periodo in ('mensal', 'anual'));

-- ── Teto GERAL do ano (espelha as colunas de `meta_mensal` em users) ──
alter table public.users
  add column if not exists meta_anual                numeric,
  add column if not exists meta_anual_ativo          boolean default true,
  add column if not exists meta_anual_alerta_ativo   boolean default true,
  add column if not exists meta_anual_alerta_pct     smallint default 80,
  -- Guarda o ANO já avisado ('2026'), igual `meta_mensal_alerta_enviado`
  -- guarda o mês. É o que garante UM aviso por ano.
  add column if not exists meta_anual_alerta_enviado text;

alter table public.users
  drop constraint if exists users_meta_anual_alerta_pct_check;
alter table public.users
  add constraint users_meta_anual_alerta_pct_check
  check (meta_anual_alerta_pct is null or meta_anual_alerta_pct between 0 and 100);

-- Índice do mesmo formato do que a 089 criou pro mensal.
create index if not exists idx_category_limits_periodo
  on public.category_limits (grupo_id, periodo, mes_referencia);
