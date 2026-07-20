-- =====================================================================
-- 085 — Categorias v3: remove as PREDEFINIDAS ANTIGAS que a v3 substituiu
--
-- Contexto: a 084 foi aditiva e deixou as padrão antigas (Mercado, Vestuário,
-- Beleza, Contas, Médico…) convivendo com as novas → "dupla categoria pra
-- mesma coisa". Aqui aposentamos as antigas.
--
-- SEGURO pras categorias do USUÁRIO: a unique é (grupo_id, nome), então quem
-- tem uma categoria chamada "Mercado" É a nossa padrão (o usuário não
-- conseguiria criar outra com o mesmo nome). Categorias criadas/adaptadas pelo
-- usuário têm OUTROS nomes → nunca são tocadas aqui.
--
-- O que faz, por grupo:
--   1. Aposenta (ativa=false) a antiga, reparentando as subs dela pro pai v3.
--   2. Remapeia as TRANSAÇÕES da antiga pro nome novo (nome puro OU "emoji nome")
--      pra o relatório também não duplicar.
--   3. Aninha as de MESMO nome que ficaram no topo dentro do pai v3
--      (ex.: Combustível → Transporte, Padaria → Alimentação).
--   4. Renomeia "Lazer e Entretenimento" → "Lazer" (a v3 reusou essa linha).
--
-- Idempotente. NÃO recria nada; só desativa/reparenta/renomeia + remapeia tx.
-- =====================================================================

-- ── Aposenta uma padrão antiga substituída por outra de nome diferente ──
create or replace function public._v3_aposentar(p_grupo uuid, p_old text, p_new_parent text, p_new_label text)
returns void language plpgsql as $$
declare v_old uuid; v_np uuid;
begin
  select id into v_old from public.categorias
   where grupo_id = p_grupo and lower(btrim(nome)) = lower(btrim(p_old))
     and coalesce(ativa, true) = true
   limit 1;
  if v_old is null then return; end if;

  -- pai v3 (raiz ativa) pra onde as subs da antiga vão
  select id into v_np from public.categorias
   where grupo_id = p_grupo and parent_id is null and coalesce(ativa, true) = true
     and lower(btrim(nome)) = lower(btrim(p_new_parent))
   limit 1;
  if v_np is not null and v_np <> v_old then
    update public.categorias set parent_id = v_np
     where grupo_id = p_grupo and parent_id = v_old;
  end if;

  -- transações da antiga → nome novo (cobre "Mercado" e "🛒 Mercado")
  update public.transacoes set categoria = p_new_label
   where grupo_id = p_grupo
     and (lower(categoria) = lower(p_old) or categoria ilike '% ' || p_old);

  update public.categorias set ativa = false where id = v_old;
end; $$;

-- ── Aninha uma categoria (mesmo nome) dentro do pai v3, esteja ela no topo
--    OU sob outro pai (ex.: iFood hoje é sub de Alimentação → vai pra Delivery) ──
create or replace function public._v3_ninhar(p_grupo uuid, p_sub text, p_parent text)
returns void language plpgsql as $$
declare v_par uuid;
begin
  select id into v_par from public.categorias
   where grupo_id = p_grupo and parent_id is null and coalesce(ativa, true) = true
     and lower(btrim(nome)) = lower(btrim(p_parent))
   limit 1;
  if v_par is null then return; end if;
  update public.categorias set parent_id = v_par
   where grupo_id = p_grupo and coalesce(ativa, true) = true
     and lower(btrim(nome)) = lower(btrim(p_sub))
     and id <> v_par and parent_id is distinct from v_par;
end; $$;

-- ── Aplica a todos os grupos ──────────────────────────────────────────
do $$
declare g record;
begin
  for g in select id from public.grupos loop
    -- 1) aposenta as antigas substituídas (reparent + remap tx)
    perform public._v3_aposentar(g.id, 'Mercado',                'Alimentação', '🛒 Supermercado');
    perform public._v3_aposentar(g.id, 'Contas',                 'Moradia',     '🏠 Moradia');
    perform public._v3_aposentar(g.id, 'Vestuário',              'Compras',     '🛍️ Compras');
    perform public._v3_aposentar(g.id, 'Beleza',                 'Autocuidado', '🧼 Autocuidado');
    perform public._v3_aposentar(g.id, 'Médico',                 'Saúde',       '🩺 Consultas');
    perform public._v3_aposentar(g.id, 'Casa',                   'Compras',     '🛍️ Compras');
    perform public._v3_aposentar(g.id, 'Vendas',                 'Negócio',     '🚀 Negócio');
    perform public._v3_aposentar(g.id, 'Lazer e Entretenimento', 'Lazer',       '🎮 Lazer');

    -- 2) renomeia a linha "Lazer e Entretenimento" (que a v3 reusou) → "Lazer",
    --    se ainda não houver uma "Lazer" separada.
    if not exists (select 1 from public.categorias
                    where grupo_id = g.id and lower(btrim(nome)) = 'lazer' and coalesce(ativa,true)=true) then
      update public.categorias set nome = 'Lazer', icone = '🎮'
       where grupo_id = g.id and parent_id is null
         and lower(btrim(nome)) = 'lazer e entretenimento';
    end if;

    -- 3) aninha as de mesmo nome que ficaram no topo dentro do pai v3
    perform public._v3_ninhar(g.id, 'Combustível',   'Transporte');
    perform public._v3_ninhar(g.id, 'iFood',         'Delivery');
    perform public._v3_ninhar(g.id, 'Internet',      'Moradia');
    perform public._v3_ninhar(g.id, 'Impostos',      'Financeiro');
    perform public._v3_ninhar(g.id, 'Padaria',       'Alimentação');
    perform public._v3_ninhar(g.id, 'Presente',      'Compras');
    perform public._v3_ninhar(g.id, 'Financiamento', 'Moradia');
    perform public._v3_ninhar(g.id, 'Filhos',        'Família');
    perform public._v3_ninhar(g.id, 'Pet',           'Família');
    perform public._v3_ninhar(g.id, 'Viagem',        'Lazer');
    perform public._v3_ninhar(g.id, 'Salário',       'Trabalho');
    perform public._v3_ninhar(g.id, 'Netflix',       'Assinaturas');
    perform public._v3_ninhar(g.id, 'Spotify',       'Assinaturas');
  end loop;
end; $$;

-- =====================================================================
-- Verificação (deve mostrar só as v3 + as suas próprias; sem Mercado/Vestuário/
-- Beleza/Contas/Médico ativas):
--   select nome, icone, tipo, ativa from public.categorias
--    where grupo_id = '<seu_grupo>' and parent_id is null order by ativa desc, nome;
-- =====================================================================
