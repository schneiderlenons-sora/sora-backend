-- =====================================================================
-- 070 — Coluna users.lembretes_ativos (Central de Avisos)
-- O código (rotas/avisos + crons) usa `lembretes_ativos`, mas nenhuma migration
-- criava a coluna. Sem ela, o GET /api/user/avisos listava a coluna inexistente,
-- o select falhava INTEIRO e devolvia todos os defaults → os toggles (briefing,
-- checkup de hábitos) apareciam DESLIGADOS mesmo salvos. Idempotente.
-- (lembretes_dividas já existe; incluída aqui por segurança/idempotência.)
-- =====================================================================

alter table public.users add column if not exists lembretes_ativos  boolean not null default true;
alter table public.users add column if not exists lembretes_dividas boolean not null default true;

-- =====================================================================
-- Verificação:
--   select column_name from information_schema.columns
--     where table_name='users' and column_name in ('lembretes_ativos','lembretes_dividas');
-- =====================================================================
