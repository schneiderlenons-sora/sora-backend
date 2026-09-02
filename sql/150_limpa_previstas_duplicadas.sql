-- =============================================================================
-- 150 — Remove as parcelas PREVISTAS duplicadas pelo reprocessamento da Polp
--
-- Companheira do fix em `services/parcelasPrevistas.js` (dedup por DIA da
-- compra, não pelo instante ao segundo). O código já não gera mais duplicata;
-- esta migration limpa as que ficaram gravadas.
--
-- ⚠️ NADA AQUI É DADO DO USUÁRIO. `of_parcelas_previstas` é PROJEÇÃO — apagada
-- e reescrita inteira a cada sync. Rodar isto só antecipa o que o próximo sync
-- faria sozinho, e serve pros cartões que demorariam a sincronizar.
--
-- A REGRA É A MESMA DO CÓDIGO: mesmo cartão + competência + total de parcelas
-- + mesmo DIA de compra, com valor a menos de R$ 1 de diferença → fica a de
-- MENOR valor (nos pares reais medidos, o app do banco mostrava a menor).
--
-- MEDIDO ANTES DE ESCREVER, nas 664 linhas da tabela:
--   linhas removidas ....................... 75
--     destas, com descrição IDÊNTICA ....... 75   ← todas
--     com descrição diferente .............. 0
--   valor tirado do previsto ............... R$ 11.737,66
--
-- ⚠️ E O QUE **NÃO** SAI: 38 pares caem no mesmo dia com o mesmo número de
-- parcelas mas com valor distante — e são compras diferentes de verdade:
--   R$ 106,63 "LOJAS RENNER"     × R$ 189,99 "CA MODAS"
--   R$  99,94 "GROWTHSUPPLEME"   × R$ 113,93 "NIKE"
--   R$  18,00 "BRASIL PARAL"     × R$  99,00 "BRASIL PARAL"  ← mesma loja, 2 planos
-- É a tolerância de R$ 1 que os separa. Sem ela, a limpeza fundiria compras
-- legítimas — por isso a condição de valor está no WHERE, e não só o dia.
--
-- Idempotente. Aplicar: Supabase Dashboard → SQL Editor → Run.
-- =============================================================================

-- CONFIRA ANTES (deve listar 75 linhas):
--
--   with r as (
--     select id, descricao, valor, competencia,
--            min(valor) over w as menor,
--            row_number() over (partition by cartao_id, competencia, parcela_total,
--                                            left(assinatura, 10)
--                               order by valor asc, id asc) as rn
--       from public.of_parcelas_previstas
--      where assinatura is not null and length(assinatura) >= 10
--     window w as (partition by cartao_id, competencia, parcela_total, left(assinatura, 10))
--   )
--   select competencia, descricao, valor, menor from r
--    where rn > 1 and valor - menor <= 1
--    order by competencia, descricao;

with ranked as (
  select id,
         valor,
         min(valor) over (
           partition by cartao_id, competencia, parcela_total, left(assinatura, 10)
         ) as menor,
         row_number() over (
           partition by cartao_id, competencia, parcela_total, left(assinatura, 10)
           order by valor asc, id asc
         ) as rn
    from public.of_parcelas_previstas
   where assinatura is not null
     and length(assinatura) >= 10
)
delete from public.of_parcelas_previstas p
 using ranked r
 where p.id = r.id
   and r.rn > 1                 -- a de MENOR valor fica (rn = 1)
   and r.valor - r.menor <= 1;  -- só funde o que está a menos de R$ 1

-- CONFIRA DEPOIS (deve devolver 0):
--
--   with r as (
--     select id, valor,
--            min(valor) over w as menor,
--            row_number() over (partition by cartao_id, competencia, parcela_total,
--                                            left(assinatura, 10)
--                               order by valor asc, id asc) as rn
--       from public.of_parcelas_previstas
--      where assinatura is not null and length(assinatura) >= 10
--     window w as (partition by cartao_id, competencia, parcela_total, left(assinatura, 10))
--   )
--   select count(*) from r where rn > 1 and valor - menor <= 1;
