-- =============================================================================
-- 131 — `transacoes.arquivada_por`: ocultar uma transação da visão do grupo
--
-- PROBLEMA: em gestão compartilhada TUDO é do grupo. Não havia como tirar um
-- lançamento da vista do parceiro — nem o presente de aniversário, nem a compra
-- que o Open Finance puxou sozinho e que a pessoa não quer expor.
--
-- ── POR QUE `uuid` E NÃO UM BOOLEAN ─────────────────────────────────────────
-- Guardar QUEM arquivou é o que faz a aba "Arquivadas" existir: a transação
-- some pra todo mundo e reaparece só pra quem a escondeu. Com um boolean não
-- daria pra saber de quem é a aba, e um membro veria o que o outro arquivou.
--
-- ── O QUE "ARQUIVADA" SIGNIFICA ─────────────────────────────────────────────
-- Sai de TUDO que é visão normal: lista, dashboard, resumo, categorias,
-- relatórios, Wrapped e as respostas do WhatsApp. Não é "some da lista mas
-- conta no total" — isso deixaria a soma das linhas diferente do total exibido,
-- que é exatamente o tipo de número mágico que passamos semanas caçando na
-- fatura do cartão.
--
-- ⚠️ NÃO MEXE NO SALDO DA CONTA. O dinheiro saiu do banco de verdade, e em
-- conta de Open Finance o saldo vem do próprio banco. Arquivar é decisão de
-- EXIBIÇÃO, não de contabilidade — apagar o valor do saldo faria o painel
-- divergir do extrato.
--
-- ⚠️ FALHA ABERTA, de propósito. Se algum ponto de leitura esquecer o filtro, a
-- transação apenas continua aparecendo — ninguém vê nada que já não pudesse
-- ver antes. Foi o que fez esta versão ser preferida a uma "transação privada"
-- de verdade, onde esquecer um filtro vazaria gasto íntimo pro parceiro.
--
-- Idempotente. Rodar no Supabase → SQL Editor.
-- =============================================================================

alter table public.transacoes
  add column if not exists arquivada_por uuid references auth.users(id) on delete set null;

alter table public.transacoes
  add column if not exists arquivada_em timestamptz;

comment on column public.transacoes.arquivada_por is
  'Quem arquivou a transação. NULL = visível normalmente. Preenchido = some da '
  'visão de todos e aparece só na aba "Arquivadas" de quem arquivou. Ver sql/131.';

-- Índice parcial: a esmagadora maioria das linhas fica NULL, e a consulta que
-- importa é "as minhas arquivadas".
create index if not exists idx_tx_arquivada_por
  on public.transacoes(arquivada_por, data desc)
  where arquivada_por is not null;

-- =============================================================================
-- Verificação:
--   select count(*) filter (where arquivada_por is not null) as arquivadas,
--          count(*) as total
--     from public.transacoes;
--
--   select data, valor, observacao, arquivada_por, arquivada_em
--     from public.transacoes where arquivada_por is not null
--    order by arquivada_em desc limit 20;
-- =============================================================================
