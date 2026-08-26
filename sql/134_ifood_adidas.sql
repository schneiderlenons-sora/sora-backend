-- =====================================================================
-- 134 — iFood (prefixo IFD*) e Adidas (PayU *ADI) no HISTÓRICO
--
-- O categorizador passou a reconhecer o descritor do adquirente: `IFD*` é o
-- iFood e `PayU *ADI` é a Adidas truncada em 22 caracteres. Mas o sync do Open
-- Finance **nunca reescreve linha existente** (dedup por `of_tx_id`) — e isso é
-- de propósito: é o que protege a categoria que o usuário corrigiu à mão.
-- Sem esta migration o passado fica errado PARA SEMPRE.
--
-- Medido na base antes de rodar:
--   IFD*      73 lançamentos · R$ 4.431,65 · 11 categorias diferentes
--             (Restaurante 19 · Outros 22 · Lanches 8 · Farmácia 5 · iFood 4…)
--   PayU*ADI   1 lançamento  · R$   139,99 · em Outros
--   → 71 linhas mudam, em 9 grupos.
--
-- ⚠️ DUAS PROTEÇÕES, as duas medidas (2 linhas seriam estragadas sem elas):
--
--   1. `transferencia IS NOT TRUE`. Um estorno do iFood ("CANCELAMENTO PARCIAL
--      DE COMPRA - IFD*RECANTO…") é crédito: hoje ele ABATE a fatura. Virar
--      "iFood" o tornaria um Gasto comum, a fatura subiria sozinha e o
--      relatório contaria a compra duas vezes. Quem manda no crédito é a
--      DIREÇÃO do lançamento, nunca o texto. Mesma trava protege a linha que o
--      emissor marcou como pagamento de fatura.
--
--   2. `tipo = 'Gasto'`. Mesma ideia pelo outro lado.
--
-- ⚠️ A CATEGORIA DE DESTINO PRECISA EXISTIR NA TAXONOMIA. `categoria` é texto
-- livre: apontar pra um nome que não é categoria cadastrada some da aba
-- Categorias do mesmo jeito — seria trocar um bug pelo outro (é a lição que a
-- 132 registrou com `Pix enviado`). Medido: 2 dos 9 grupos não têm a
-- subcategoria iFood. O passo 1 cria antes de mover.
--
-- Idempotente: rodar de novo não muda mais nada.
-- =====================================================================

-- ── 1) Garante a subcategoria iFood (🛵, sob Delivery) onde falta ──────
-- Só nos grupos que realmente têm lançamento IFD* — não polui a taxonomia de
-- quem nunca pediu iFood. `criar_cat_v4`/`criar_sub_v4` (sql/087) já são
-- create-or-get, então isto é seguro de repetir.
do $$
declare
  g uuid;
  v_delivery uuid;
begin
  for g in
    select distinct t.grupo_id
      from public.transacoes t
     where t.observacao ~* '(^|[^a-z0-9])ifd([^a-z0-9]|$)'
       and not exists (
         select 1 from public.categorias c
          where c.grupo_id = t.grupo_id
            and lower(btrim(c.nome)) = 'ifood')
  loop
    v_delivery := public.criar_cat_v4(g, 'Delivery', '🛵', 'despesa');
    perform public.criar_sub_v4(g, v_delivery, 'iFood', '🛵');
  end loop;
end $$;

-- ── 2) IFD* → iFood ───────────────────────────────────────────────────
-- O regex exige `ifd` como palavra INTEIRA (mesma regra do categorizador, que
-- trata keyword de 3 letras assim). Sem isso "SWIFDATA" viraria iFood.
update public.transacoes
   set categoria = 'iFood'
 where observacao ~* '(^|[^a-z0-9])ifd([^a-z0-9]|$)'
   and tipo = 'Gasto'
   and transferencia is not true
   and lower(btrim(coalesce(categoria, ''))) <> 'ifood';

-- ── 3) PayU *ADI → Adidas ─────────────────────────────────────────────
-- 'payu' sozinho é gateway de muita loja; exige as duas palavras juntas.
update public.transacoes
   set categoria = 'Adidas'
 where observacao ~* 'payu[^a-z0-9]+adi'
   and tipo = 'Gasto'
   and transferencia is not true
   and lower(btrim(coalesce(categoria, ''))) <> 'adidas';

-- ── Conferência (rodar solto no SQL Editor, opcional) ─────────────────
-- select categoria, count(*), sum(valor)
--   from public.transacoes
--  where observacao ~* '(^|[^a-z0-9])ifd([^a-z0-9]|$)'
--  group by 1 order by 2 desc;
-- Esperado: quase tudo em 'iFood'; sobram só as linhas de crédito/fatura.
