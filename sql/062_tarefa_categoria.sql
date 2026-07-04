-- =====================================================================
-- 062 — Categoria nas tarefas.
-- A Sora infere a categoria (Viagem, Compras, Trabalho, Saúde, Estudos, Casa,
-- Contatos, Financeiro) por mapa de palavras local ao criar tarefa por
-- linguagem natural ("lembra de comprar as passagens" → Viagem).
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =====================================================================

alter table public.tarefas add column if not exists categoria text;
