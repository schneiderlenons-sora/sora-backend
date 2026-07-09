-- 066_recorrencia_variavel.sql
-- Gastos/Receitas VARIÁVEIS: contas recorrentes cujo valor muda todo mês
-- (luz, água, cartão, freela). A recorrência vira "prevista" — no dia do
-- vencimento a Sora cria um lançamento PENDENTE com o valor ESTIMADO (coluna
-- valor) e não debita a carteira; o usuário confirma o valor real no painel.
-- Fixo (default) = comportamento atual (lança automático com valor exato).
-- Idempotente. Rodar à mão no Supabase → SQL Editor.

alter table public.recorrencias
  add column if not exists valor_variavel boolean not null default false;
