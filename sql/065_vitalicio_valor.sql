-- 065_vitalicio_valor.sql
-- Guarda o valor efetivamente pago num plano vitalício (após cupom), pra o admin
-- somar a "receita vitalícia" com precisão. Vitalícios antigos ficam NULL → o
-- admin cai no preço do tier (kit R$47 / premium R$97) como estimativa.
-- Idempotente. Rodar à mão no Supabase → SQL Editor.

alter table public.users add column if not exists vitalicio_valor numeric;
