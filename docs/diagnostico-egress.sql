-- =============================================================================
-- DIAGNÓSTICO DE EGRESS — quais consultas estão consumindo a cota do Supabase.
--
-- Rodar no Supabase → SQL Editor. É LEITURA PURA: não altera nada.
--
-- POR QUE ISTO EXISTE: o gráfico "Egress per day" mostra QUANTO, nunca O QUÊ.
-- Ele diz que ~98% é PostgREST (consulta de dados) e para por aí.
-- `pg_stat_statements` NOMEIA a consulta, com número de chamadas e linhas.
--
-- ⚠️ LEIA A COLUNA `calls`, NÃO SÓ O TEMPO. Egress é byte que sai: uma consulta
-- pequena chamada 200 mil vezes gasta mais cota que uma pesada chamada dez
-- vezes. O ranking por tempo total engana aqui.
--
-- ⚠️⚠️ ERRO QUE ESTE ARQUIVO JÁ TEVE, E QUE CUSTOU UMA RODADA INTEIRA (16/09):
-- as consultas filtravam por `query ilike 'select%'`. **O PostgREST não gera
-- SQL que começa com `select`** — ele embrulha tudo em
-- `WITH pgrst_source AS (...) SELECT ...`. Com aquele filtro, 98% do consumo
-- ficava de fora e o resultado voltava só com ruído interno do Supabase (auth,
-- pg_type, schema_migrations, pgbouncer) — nenhuma tabela da aplicação.
-- Filtre por `"public"."`, que é como o PostgREST qualifica as tabelas.
-- =============================================================================

create extension if not exists pg_stat_statements;

-- ── 0. DESDE QUANDO estas estatísticas contam ───────────────────────────────
-- Sem isto, `calls` é número sem denominador: 294 mil chamadas podem ser de
-- dois dias ou de dois meses. Rode SEMPRE junto com as outras.
select stats_reset,
       now() - stats_reset                                      as periodo,
       round(extract(epoch from now() - stats_reset) / 3600, 1) as horas
from pg_stat_statements_info;

-- ── 1. Quantas REQUISIÇÕES o PostgREST recebeu no período ───────────────────
-- Ele roda este `set_config` uma vez POR REQUISIÇÃO. É o total de idas ao banco
-- pela API — e cada ida custa ~1,1 KB só de cabeçalho HTTP, mesmo quando a
-- resposta é minúscula. Multiplicado por 1,1 KB dá o PISO do egress.
select calls                        as requisicoes_postgrest,
       round(calls * 1.1 / 1024, 1) as mb_so_de_cabecalho
from pg_stat_statements
where query like 'select set_config(%search_path%';

-- ── 2. As 30 consultas da APLICAÇÃO mais CHAMADAS ───────────────────────────
-- Aqui aparece o que roda em laço: cron apertado, polling, N+1.
select calls,
       rows,
       round(rows::numeric / nullif(calls, 0), 1) as linhas_por_chamada,
       left(regexp_replace(query, '\s+', ' ', 'g'), 220) as consulta
from pg_stat_statements
where query like '%"public"."%'
order by calls desc
limit 30;

-- ── 3. As 30 que mais devolvem LINHA ────────────────────────────────────────
-- `rows` é o proxy mais direto de volume: linha devolvida é byte que sai.
-- Compare com a 2: chamada demais e linha demais pedem correções diferentes
-- (lote/cache × estreitar colunas).
select calls,
       rows,
       round(rows::numeric / nullif(calls, 0), 1) as linhas_por_chamada,
       left(regexp_replace(query, '\s+', ' ', 'g'), 220) as consulta
from pg_stat_statements
where query like '%"public"."%'
order by rows desc
limit 30;

-- ── 4. Rede de segurança: top 30 SEM filtro nenhum ──────────────────────────
-- Se as consultas 2 e 3 voltarem vazias, o PostgREST desta versão pode estar
-- gerando SQL em outro formato. Esta mostra tudo, e aí dá pra achar o padrão
-- olhando o texto — foi a falta dela que deixou o erro do filtro passar.
-- select calls, rows, left(regexp_replace(query, '\s+', ' ', 'g'), 220) as consulta
--   from pg_stat_statements
--  order by calls desc
--  limit 30;

-- ── 5. Tamanho das tabelas (contexto pro que aparecer acima) ────────────────
-- select relname as tabela,
--        n_live_tup as linhas,
--        pg_size_pretty(pg_total_relation_size(relid)) as tamanho
--   from pg_stat_user_tables
--  order by pg_total_relation_size(relid) desc
--  limit 20;

-- ── 6. Zerar o contador ─────────────────────────────────────────────────────
-- Rode DEPOIS de anotar o resultado, espere um dia e leia de novo: assim o
-- ranking reflete só o período novo, já com as correções no ar.
-- select pg_stat_statements_reset();
