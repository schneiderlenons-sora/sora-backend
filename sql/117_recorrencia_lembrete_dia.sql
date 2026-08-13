-- =====================================================================
-- 117 — Dedup do lembrete PURO (modo nao_lancar) por dia
--
-- POR QUÊ: recorrência em modo 'nao_lancar' (Open Finance já traz a cobrança
-- real; a Sora só avisa) NÃO cria transação nenhuma — de propósito, é o
-- design do modo. Mas o JOB 1A roda a cada hora dentro da janela 8h–10h SP, e
-- sem transação não havia NADA que impedisse o mesmo lembrete de entrar no
-- balde de novo a cada rodada: usuário recebia o mesmo "Recorrências de hoje"
-- às 08h, 09h e 10h.
--
-- Mesmo formato do fix já feito pro `ultimo_previsto_ym` (sql/099) — dedup
-- NA PRÓPRIA recorrência, imune a qualquer coisa que aconteça (ou não) na
-- tabela de transações.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.recorrencias
  add column if not exists ultimo_lembrete_dia text;
