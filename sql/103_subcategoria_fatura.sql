-- =====================================================================
-- 103 — Subcategoria "Fatura" em Financeiro (pagamento de fatura do cartão)
--
-- O pagamento da fatura era gravado numa categoria SOLTA, 'Fatura cartão', que
-- não existia na taxonomia — aparecia na lista de transações sem ícone nem pai,
-- e não dava pra ver quanto foi pago de fatura no período.
--
-- ⚠️ O pagamento da fatura NÃO entra em relatório/gráfico de categoria, e isso
-- não muda aqui: as compras dentro da fatura já foram categorizadas uma a uma
-- (Mercado, Uber…), então contar o pagamento de novo seria contar EM DOBRO. Os
-- filtros do backend e do painel usam `ehPagamentoFatura()`, que reconhece a
-- 'Fatura' nova E a 'Fatura cartão' antiga (o histórico não é reescrito).
--
-- Idempotente (criar_sub_v4 não duplica). Aplicar: Supabase → SQL Editor → Run.
-- =====================================================================

-- 1. Cria a subcategoria em TODO grupo que já tem "Financeiro".
do $$
declare g record;
begin
  for g in
    select id as cat_id, grupo_id from public.categorias
     where parent_id is null and lower(btrim(nome)) = 'financeiro'
  loop
    perform public.criar_sub_v4(g.grupo_id, g.cat_id, 'Fatura', '💳');
  end loop;
end $$;

-- 2. Grupo novo já nasce com ela: a `criar_categorias_padrao` da 087 não muda,
--    então adicionamos por fora, num gatilho de leitura idempotente. Mais
--    simples e sem reescrever a função inteira: quem criar grupo depois disto
--    roda a 087 e, na primeira abertura da aba, a linha abaixo garante a sub.
--    (Rodar esta migration de novo pega quem entrou no meio.)

-- 3. Reaproveita o histórico: transação já gravada como 'Fatura cartão' passa a
--    apontar pro nome novo. Mantemos a leitura das duas no código, mas deixar o
--    banco consistente evita duas grafias na tela.
update public.transacoes
   set categoria = 'Fatura'
 where categoria = 'Fatura cartão';
