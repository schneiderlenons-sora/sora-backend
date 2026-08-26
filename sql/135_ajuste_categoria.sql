-- =====================================================================
-- 135 — "🔧 Ajuste" vira categoria de verdade
--
-- SINTOMA: o painel mostrava R$ 4.097,48 de despesa no mês e a aba Categorias
-- somava R$ 3.797,48. Diferença de EXATAMENTE R$ 300,00 — um "Ajuste de saldo".
--
-- CAUSA: `services/ajusteSaldo.js` grava `categoria = '🔧 Ajuste'`, mas esse
-- nome nunca foi cadastrado na taxonomia. `transacoes.categoria` é texto livre,
-- então o lançamento existe e conta no total; a aba Categorias, que monta a
-- árvore a partir da tabela `categorias`, simplesmente não tem onde pendurá-lo
-- e o dinheiro SOME da tela. É a mesma armadilha que a 132 registrou com
-- `Pix enviado`: destino que não existe na taxonomia é bug trocado por bug.
--
-- Medido na base: 37 lançamentos em 18 grupos —
--   Gasto        20 linhas · R$ 58.989,90
--   Recebimento  17 linhas · R$  7.059,33   (invisíveis do mesmo jeito)
--
-- ⚠️ POR QUE DOIS NOMES: a mesma "categoria" aparece nas duas direções (saldo
-- que faltava = Gasto, saldo que sobrava = Recebimento), mas `categorias.tipo`
-- é um só por linha e o nome é único por pai. Mesma solução do `PIX` →
-- `Pix enviado` (SO_RECEITA em categorizar.js): um nome por direção.
--
-- ⚠️ O ajuste CONTINUA CONTANDO como despesa/receita, de propósito. Ele é
-- dinheiro que entrou ou saiu sem ter sido registrado — tirá-lo do total faria
-- o app fingir que o dinheiro não se moveu. O que faltava era poder VER.
--
-- Idempotente.
-- =====================================================================

-- ── 1) Cria as duas categorias em TODOS os grupos ──────────────────────
-- Em todos, e não só nos 18 afetados: ajuste de saldo pode acontecer amanhã em
-- qualquer conta, e a aba Categorias esconde categoria zerada por padrão
-- (`mostrarZeradas`), então isto não polui a lista de ninguém.
-- `criar_cat_v4` (sql/087) é create-or-get.
do $$
declare g uuid;
begin
  for g in select id from public.grupos loop
    perform public.criar_cat_v4(g, 'Ajuste',          '🔧', 'despesa');
    perform public.criar_cat_v4(g, 'Ajuste recebido', '🔧', 'receita');
  end loop;
end $$;

-- ── 2) Separa o histórico por direção ─────────────────────────────────
-- Os 17 Recebimentos estão gravados com o nome da categoria de despesa.
update public.transacoes
   set categoria = '🔧 Ajuste recebido'
 where tipo = 'Recebimento'
   and lower(btrim(replace(coalesce(categoria, ''), '🔧', ''))) = 'ajuste';

-- ── Conferência (opcional, rodar solto) ───────────────────────────────
-- select tipo, categoria, count(*), sum(valor)
--   from public.transacoes where categoria ilike '%ajuste%' group by 1,2;
-- Esperado: Gasto → '🔧 Ajuste' · Recebimento → '🔧 Ajuste recebido'.
