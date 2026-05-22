-- =====================================================================
-- 017 — Adiciona coluna `tipo` em `categorias` (despesa | receita)
-- Permite que o modal de Nova Transação filtre categorias pelo tipo
-- escolhido, e que o usuário crie categorias de receita explicitamente.
-- Idempotente: roda múltiplas vezes sem erro.
-- =====================================================================

alter table public.categorias
  add column if not exists tipo text default 'despesa'
    check (tipo in ('despesa','receita'));

-- Backfill: marca como receita as categorias com nomes conhecidos de entrada
update public.categorias
   set tipo = 'receita'
 where tipo = 'despesa'
   and nome in (
     'Salário', 'Salario',
     'Freelance',
     'Bônus', 'Bonus',
     'Aluguel Recebido',
     'Rendimentos',
     'Dividendos',
     'Presente',
     'Venda de itens',
     'Outras receitas',
     'Recebimento'
   );

create index if not exists categorias_grupo_tipo_idx
  on public.categorias (grupo_id, tipo)
  where ativa = true;

-- =====================================================================
-- Verificação rápida (rode após aplicar):
--   select tipo, count(*) from public.categorias group by tipo;
-- =====================================================================
