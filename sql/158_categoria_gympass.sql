-- =============================================================================
-- 158 — categoria "Gympass" com as subcategorias Wellhub e TotalPass.
--
-- Benefício de academia deixa de cair solto em "Academia": quem paga Wellhub ou
-- TotalPass paga um BENEFÍCIO (mensalidade de plataforma), não uma academia
-- específica, e separar os dois é o que deixa ver quanto custa cada coisa. O
-- categorizador já devolve "Wellhub" e "TotalPass" (as duas palavras saíram da
-- lista de Academia, senão ela venceria antes — quem casa primeiro ganha).
--
-- ⚠️ WELLHUB É O GYMPASS. A empresa trocou de nome em 2024 e a cobrança ainda
-- chega das duas formas, por isso as duas palavras caem na MESMA subcategoria.
--
-- ⚠️ TOTALPASS É CONCORRENTE DO GYMPASS, não faz parte dele. Mora aqui por ser
-- o mesmo TIPO de despesa, que é como quem paga enxerga a conta — não por
-- pertencer à mesma empresa. Fica registrado pra ninguém "corrigir" isso depois
-- achando que foi engano.
--
-- ⚠️ RODA PARA TODOS OS GRUPOS, não só pros novos. Categoria criada só em
-- `criar_categorias_padrao` nasce apenas para quem se cadastrar depois, e o
-- categorizador passaria a devolver um nome que não existe no catálogo do
-- grupo — que é exatamente o defeito da memória `project-categorias-v3`: nome
-- fantasma cai em "Outros", calado.
-- =============================================================================

create or replace function public.criar_categoria_gympass(p_grupo_id uuid)
returns void language plpgsql as $$
declare v_pai uuid;
begin
  -- Reusa a categoria homônima se o usuário já criou uma à mão, em vez de
  -- duplicar (mesma ideia do `criar_cat_v4` da migration 087).
  select id into v_pai
    from public.categorias
   where grupo_id = p_grupo_id
     and parent_id is null
     and lower(btrim(nome)) = 'gympass'
   limit 1;

  if v_pai is null then
    insert into public.categorias (grupo_id, nome, parent_id, icone, cor, tipo, ativa)
    values (p_grupo_id, 'Gympass', null, '🏋️', '#808080', 'despesa', true)
    returning id into v_pai;
  end if;

  -- `where not exists` deixa a migration idempotente: rodar duas vezes não cria
  -- par repetido nem estoura o unique de (grupo, pai, nome) da 087.
  insert into public.categorias (grupo_id, nome, parent_id, icone, cor, tipo, ativa)
  select p_grupo_id, 'Wellhub', v_pai, '🏋️', '#808080', 'despesa', true
   where not exists (
     select 1 from public.categorias
      where grupo_id = p_grupo_id and parent_id = v_pai
        and lower(btrim(nome)) = 'wellhub');

  insert into public.categorias (grupo_id, nome, parent_id, icone, cor, tipo, ativa)
  select p_grupo_id, 'TotalPass', v_pai, '🏋️', '#808080', 'despesa', true
   where not exists (
     select 1 from public.categorias
      where grupo_id = p_grupo_id and parent_id = v_pai
        and lower(btrim(nome)) = 'totalpass');
end $$;

comment on function public.criar_categoria_gympass(uuid) is
  'Cria a categoria Gympass e as subcategorias Wellhub e TotalPass no grupo. Idempotente.';

-- ── Backfill: todos os grupos que já existem ────────────────────────────────
do $$
declare g record;
begin
  for g in select id from public.grupos loop
    perform public.criar_categoria_gympass(g.id);
  end loop;
end $$;

-- ── Grupos novos ────────────────────────────────────────────────────────────
-- ⚠️ ANEXA à função padrão em vez de reescrevê-la: `criar_categorias_padrao` é
-- a taxonomia v4 inteira (migration 087), e recriá-la aqui só pra somar duas
-- linhas arriscaria perder tudo o que veio depois dela.
create or replace function public.criar_categorias_padrao_com_gympass(p_grupo_id uuid)
returns void language plpgsql as $$
begin
  perform public.criar_categorias_padrao(p_grupo_id);
  perform public.criar_categoria_gympass(p_grupo_id);
end $$;

-- ── Reclassifica o que já foi lançado ───────────────────────────────────────
--
-- ⚠️ A COLUNA É `observacao`, NÃO `descricao`. `transacoes` não tem `descricao`
-- (quem tem é `recorrencias`); escrever o nome errado aqui derruba a migration
-- inteira no meio.
--
-- ⚠️ SÓ O QUE ESTÁ EM "Academia" OU "Outros". Medido na base antes de escrever:
-- das 7 transações com "totalpass" na observação, 3 estão como **Fatura** —
-- são pagamento de fatura de cartão, marcados como transferência. Reclassificar
-- essas transformaria uma transferência em DESPESA e inflaria o gasto de quem
-- as tem. Outra está em "🎞️ Assinaturas", escolha manual, e mexer nela é
-- desfazer o que a pessoa decidiu.
--
-- Efeito real medido: 1 linha de Wellhub e 3 de TotalPass mudam de categoria.
update public.transacoes t
   set categoria = 'Wellhub'
 where (t.observacao ilike '%wellhub%' or t.observacao ilike '%gympass%')
   and coalesce(t.categoria, '') in ('Academia', '🏋️ Academia', 'Outros', '📦 Outros', '');

update public.transacoes t
   set categoria = 'TotalPass'
 where (t.observacao ilike '%totalpass%' or t.observacao ilike '%total pass%')
   and coalesce(t.categoria, '') in ('Academia', '🏋️ Academia', 'Outros', '📦 Outros', '');
