-- =============================================================================
-- DIAGNÓSTICO DE EGRESS — quais consultas estão consumindo a cota do Supabase.
--
-- Rodar no Supabase → SQL Editor. É LEITURA PURA: não altera nada.
--
-- POR QUE ISTO EXISTE: o gráfico "Egress per day" mostra QUANTO, nunca O QUÊ.
-- Ele diz que 97% é PostgREST (consulta de dados) e para por aí. Sem isto, a
-- investigação vira leitura de código e palpite — foi assim que se chegou às
-- correções de 06/09 (categorias, fotos em base64), mas palpite não fecha conta.
-- `pg_stat_statements` NOMEIA a consulta, com número de chamadas e linhas.
--
-- ⚠️ LEIA A COLUNA `calls`, NÃO SÓ O TEMPO. Egress é bytes que saem: uma
-- consulta pequena chamada 200 mil vezes gasta mais cota que uma pesada chamada
-- dez vezes. O ranking por tempo total engana aqui.
-- =============================================================================

-- Habilita a extensão (idempotente; já vem ligada em boa parte dos projetos).
create extension if not exists pg_stat_statements;

-- ── 1. As 25 consultas que mais devolvem LINHA ──────────────────────────────
-- `rows` é o proxy mais direto de egress: linha devolvida é byte que sai.
select
  calls,
  rows,
  round(rows::numeric / nullif(calls, 0), 1) as linhas_por_chamada,
  round(total_exec_time::numeric / 1000, 1)  as segundos_total,
  left(regexp_replace(query, '\s+', ' ', 'g'), 160) as consulta
from pg_stat_statements
where query ilike 'select%'
order by rows desc
limit 25;

-- ── 2. As 25 mais CHAMADAS ──────────────────────────────────────────────────
-- Aqui aparece o que roda em loop: cron apertado, polling, N+1.
-- select calls, rows, left(regexp_replace(query, '\s+', ' ', 'g'), 160) as consulta
--   from pg_stat_statements
--  where query ilike 'select%'
--  order by calls desc
--  limit 25;

-- ── 3. Tamanho das tabelas (contexto pro que for aparecer acima) ────────────
-- select relname as tabela,
--        n_live_tup as linhas,
--        pg_size_pretty(pg_total_relation_size(relid)) as tamanho
--   from pg_stat_user_tables
--  order by pg_total_relation_size(relid) desc
--  limit 20;

-- ── 4. Zerar o contador ─────────────────────────────────────────────────────
-- Rode DEPOIS de anotar o resultado, espere um dia e rode a consulta 1 de novo:
-- assim o ranking passa a refletir só o período novo, já com as correções no ar.
-- select pg_stat_statements_reset();
