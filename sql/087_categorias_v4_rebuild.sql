-- =====================================================================
-- 087 — Categorias v4: REBUILD exato da lista do usuário
--
-- 1. Afrouxa a unique: de (grupo_id, nome) → nome único POR PAI. Assim uma
--    subcategoria pode repetir nome em pais diferentes (ex.: "Juros" em
--    Financeiro E em Investimentos; "Investimentos" categoria E subcategoria).
-- 2. Protege as subcategorias que o USUÁRIO criou (cor numérica) e apaga SÓ as
--    nossas predefinidas (cor '#808080') — em todo grupo.
-- 3. Recria a taxonomia EXATA da lista (emojis exatos), com helpers que checam
--    existência por (PAI, nome).
-- 4. Backfill em todos os grupos + remapeia transações antigas pros nomes novos.
--
-- Idempotente.
-- =====================================================================

-- ── 1) Afrouxa a unique(grupo_id, nome) → nome único por pai ──────────
do $$
declare c record;
begin
  -- constraints unique cujo def menciona 'nome'
  for c in select conname from pg_constraint
            where conrelid = 'public.categorias'::regclass and contype = 'u'
              and pg_get_constraintdef(oid) ilike '%nome%'
  loop execute format('alter table public.categorias drop constraint %I', c.conname); end loop;
  -- unique indexes (não-constraint) cujo def menciona 'nome'
  for c in select ic.relname as idx
             from pg_index i join pg_class ic on ic.oid = i.indexrelid
            where i.indrelid = 'public.categorias'::regclass and i.indisunique and not i.indisprimary
              and pg_get_indexdef(i.indexrelid) ilike '%nome%'
  loop execute format('drop index if exists public.%I', c.idx); end loop;
end $$;

-- nome único POR PAI (top-level fica chaveado pelo grupo → dois topos com mesmo
-- nome continuam bloqueados; mas sub pode repetir em pais diferentes).
create unique index if not exists categorias_grupo_pai_nome_uidx
  on public.categorias (grupo_id, coalesce(parent_id, grupo_id), lower(btrim(nome)));

-- ── 2) Protege subs do usuário e apaga só as nossas (cor '#808080') ──
-- Solta subs do usuário (cor ≠ cinza) que estejam sob categoria nossa.
update public.categorias set parent_id = null
 where parent_id in (select id from public.categorias where cor = '#808080')
   and coalesce(cor, '') <> '#808080';

-- Apaga nossas: primeiro as subs, depois os pais (evita FK RESTRICT).
delete from public.categorias where cor = '#808080' and parent_id is not null;
delete from public.categorias where cor = '#808080';

-- ── 3) Helpers v4 (existência por PAI, não global) ───────────────────
create or replace function public.criar_cat_v4(p_grupo uuid, p_nome text, p_icone text, p_tipo text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  -- reusa um topo homônimo (ex.: categoria do próprio usuário) em vez de duplicar
  select id into v_id from public.categorias
   where grupo_id = p_grupo and parent_id is null and lower(btrim(nome)) = lower(btrim(p_nome))
   limit 1;
  if v_id is not null then return v_id; end if;
  insert into public.categorias (grupo_id, nome, parent_id, icone, cor, tipo, ativa)
  values (p_grupo, p_nome, null, p_icone, '#808080', p_tipo, true) returning id into v_id;
  return v_id;
end; $$;

create or replace function public.criar_sub_v4(p_grupo uuid, p_parent uuid, p_nome text, p_icone text, p_tipo text default 'despesa')
returns void language plpgsql as $$
begin
  if p_parent is null then return; end if;
  if exists (select 1 from public.categorias
              where grupo_id = p_grupo and parent_id = p_parent
                and lower(btrim(nome)) = lower(btrim(p_nome))) then
    return;
  end if;
  insert into public.categorias (grupo_id, nome, parent_id, icone, cor, tipo, ativa)
  values (p_grupo, p_nome, p_parent, p_icone, '#808080', p_tipo, true);
end; $$;

-- ── criar_categorias_padrao := lista v4 EXATA ────────────────────────
create or replace function public.criar_categorias_padrao(p_grupo_id uuid)
returns void language plpgsql as $$
declare v uuid;
begin
  -- ═══════ DESPESAS ═══════
  v := public.criar_cat_v4(p_grupo_id, 'Moradia', '🏠', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Aluguel', '🔑');
  perform public.criar_sub_v4(p_grupo_id, v, 'Financiamento', '🏦');
  perform public.criar_sub_v4(p_grupo_id, v, 'Condomínio', '🏢');
  perform public.criar_sub_v4(p_grupo_id, v, 'IPTU', '🧾');
  perform public.criar_sub_v4(p_grupo_id, v, 'Água', '🚰');
  perform public.criar_sub_v4(p_grupo_id, v, 'Conta de Luz', '⚡');
  perform public.criar_sub_v4(p_grupo_id, v, 'Gás', '🔥');
  perform public.criar_sub_v4(p_grupo_id, v, 'Internet', '🌐');
  perform public.criar_sub_v4(p_grupo_id, v, 'Manutenção', '🔨');

  v := public.criar_cat_v4(p_grupo_id, 'Alimentação', '🍔', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Supermercado', '🛒');
  perform public.criar_sub_v4(p_grupo_id, v, 'Padaria', '🥖');
  perform public.criar_sub_v4(p_grupo_id, v, 'Restaurante', '🍽️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Lanches', '🌮');
  perform public.criar_sub_v4(p_grupo_id, v, 'Café', '☕');

  v := public.criar_cat_v4(p_grupo_id, 'Delivery', '🛵', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'iFood', '🛵');
  perform public.criar_sub_v4(p_grupo_id, v, 'AiqFome', '🛵');
  perform public.criar_sub_v4(p_grupo_id, v, 'Zé Delivery', '🍺');
  perform public.criar_sub_v4(p_grupo_id, v, 'Rappi', '🛵');

  v := public.criar_cat_v4(p_grupo_id, 'Transporte', '🚗', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Combustível', '⛽');
  perform public.criar_sub_v4(p_grupo_id, v, 'Uber', '🚗');
  perform public.criar_sub_v4(p_grupo_id, v, '99', '🚗');
  perform public.criar_sub_v4(p_grupo_id, v, 'Blablacar', '🚗');
  perform public.criar_sub_v4(p_grupo_id, v, 'Táxi', '🚖');
  perform public.criar_sub_v4(p_grupo_id, v, 'Ônibus', '🚌');
  perform public.criar_sub_v4(p_grupo_id, v, 'Metrô', '🚇');
  perform public.criar_sub_v4(p_grupo_id, v, 'Pedágio', '🛣️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Estacionamento', '🅿️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Manutenção do veículo', '🔧');
  perform public.criar_sub_v4(p_grupo_id, v, 'Seguro do veículo', '🛡️');

  v := public.criar_cat_v4(p_grupo_id, 'Saúde', '🏥', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Farmácia', '💊');
  perform public.criar_sub_v4(p_grupo_id, v, 'Plano de saúde', '❤️‍🩹');
  perform public.criar_sub_v4(p_grupo_id, v, 'Consultas', '🩺');
  perform public.criar_sub_v4(p_grupo_id, v, 'Exames', '🧪');
  perform public.criar_sub_v4(p_grupo_id, v, 'Psicólogo', '🧠');
  perform public.criar_sub_v4(p_grupo_id, v, 'Dentista', '🦷');

  perform public.criar_cat_v4(p_grupo_id, 'Academia', '🏋️', 'despesa');

  v := public.criar_cat_v4(p_grupo_id, 'Compras', '🛍️', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Roupas', '👕');
  perform public.criar_sub_v4(p_grupo_id, v, 'Calçados', '👟');
  perform public.criar_sub_v4(p_grupo_id, v, 'Acessórios', '⌚');
  perform public.criar_sub_v4(p_grupo_id, v, 'Eletrônicos', '💻');
  perform public.criar_sub_v4(p_grupo_id, v, 'Móveis', '🛋️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Casa e decoração', '🏡');
  perform public.criar_sub_v4(p_grupo_id, v, 'Presente', '🎁');

  v := public.criar_cat_v4(p_grupo_id, 'Encomendas', '🚚', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Aliexpress', '📦');
  perform public.criar_sub_v4(p_grupo_id, v, 'Amazon', '📦');
  perform public.criar_sub_v4(p_grupo_id, v, 'Shopee', '📦');
  perform public.criar_sub_v4(p_grupo_id, v, 'Mercado Livre', '📦');
  perform public.criar_sub_v4(p_grupo_id, v, 'Tiktok Shop', '📦');
  perform public.criar_sub_v4(p_grupo_id, v, 'Adidas', '👟');
  perform public.criar_sub_v4(p_grupo_id, v, 'Nike', '👟');
  perform public.criar_sub_v4(p_grupo_id, v, 'Shein', '👗');

  v := public.criar_cat_v4(p_grupo_id, 'Autocuidado', '🧼', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Salão de beleza', '😶‍🌫️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Barbeiro', '💈');
  perform public.criar_sub_v4(p_grupo_id, v, 'Manicure', '💅');
  perform public.criar_sub_v4(p_grupo_id, v, 'Skincare', '🧴');
  perform public.criar_sub_v4(p_grupo_id, v, 'Maquiagem', '💄');
  perform public.criar_sub_v4(p_grupo_id, v, 'Perfume', '🧴');
  perform public.criar_sub_v4(p_grupo_id, v, 'Tatuagem', '🖋️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Piercing', '💎');
  perform public.criar_sub_v4(p_grupo_id, v, 'Massagem', '💆');
  perform public.criar_sub_v4(p_grupo_id, v, 'Spa', '🧖');
  perform public.criar_sub_v4(p_grupo_id, v, 'Higiene Pessoal', '🪥');

  v := public.criar_cat_v4(p_grupo_id, 'Dieta', '🍎', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Suplementos', '🧖');
  perform public.criar_sub_v4(p_grupo_id, v, 'Whey Protein', '💪');
  perform public.criar_sub_v4(p_grupo_id, v, 'Creatina', '⚡');
  perform public.criar_sub_v4(p_grupo_id, v, 'Hipercalórico', '🥤');
  perform public.criar_sub_v4(p_grupo_id, v, 'BCAA', '🧬');
  perform public.criar_sub_v4(p_grupo_id, v, 'Pré-Treino', '🔥');
  perform public.criar_sub_v4(p_grupo_id, v, 'Vitaminas', '🍊');
  perform public.criar_sub_v4(p_grupo_id, v, 'Isotônico', '🧃');

  v := public.criar_cat_v4(p_grupo_id, 'Lazer', '🎮', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Cinema', '🎬');
  perform public.criar_sub_v4(p_grupo_id, v, 'Streaming', '📺');
  perform public.criar_sub_v4(p_grupo_id, v, 'Jogos', '🎮');
  perform public.criar_sub_v4(p_grupo_id, v, 'Eventos', '🎟️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Bares', '🍺');
  perform public.criar_sub_v4(p_grupo_id, v, 'Festas', '🎉');

  perform public.criar_cat_v4(p_grupo_id, 'Viagem', '✈️', 'despesa');

  v := public.criar_cat_v4(p_grupo_id, 'Esporte', '🏃‍♂️', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Futebol', '⚽️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Basquete', '🏀');
  perform public.criar_sub_v4(p_grupo_id, v, 'Futevôlei', '🏖️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Vôlei', '🏐');
  perform public.criar_sub_v4(p_grupo_id, v, 'Tênis', '🎾');
  perform public.criar_sub_v4(p_grupo_id, v, 'Beach Tennis', '🏓');
  perform public.criar_sub_v4(p_grupo_id, v, 'Artes Marciais', '🥋');
  perform public.criar_sub_v4(p_grupo_id, v, 'Natação', '🏊‍♂️');

  v := public.criar_cat_v4(p_grupo_id, 'Assinaturas', '🎞️', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Disney+', '📺');
  perform public.criar_sub_v4(p_grupo_id, v, 'Globo Play', '📺');
  perform public.criar_sub_v4(p_grupo_id, v, 'HBO Max', '📺');
  perform public.criar_sub_v4(p_grupo_id, v, 'Netflix', '📺');
  perform public.criar_sub_v4(p_grupo_id, v, 'Prime Video', '📺');
  perform public.criar_sub_v4(p_grupo_id, v, 'Spotify', '🎵');

  v := public.criar_cat_v4(p_grupo_id, 'Educação', '📚', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Cursos', '🎓');
  perform public.criar_sub_v4(p_grupo_id, v, 'Faculdade', '🏫');
  perform public.criar_sub_v4(p_grupo_id, v, 'Livros', '📖');
  perform public.criar_sub_v4(p_grupo_id, v, 'Material escolar', '✏️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Idiomas', '🌍');

  v := public.criar_cat_v4(p_grupo_id, 'Empreendimento', '💼', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Marketing e Publicidade', '📣');
  perform public.criar_sub_v4(p_grupo_id, v, 'Facebook Ads', '📣');
  perform public.criar_sub_v4(p_grupo_id, v, 'Google Ads', '📣');
  perform public.criar_sub_v4(p_grupo_id, v, 'Ferramentas', '🧰');
  perform public.criar_sub_v4(p_grupo_id, v, 'Softwares', '💻');
  perform public.criar_sub_v4(p_grupo_id, v, 'Hospedagem', '🖥️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Domínio', '🌍');
  perform public.criar_sub_v4(p_grupo_id, v, 'Equipamentos', '🖨️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Fornecedores', '🚚');
  perform public.criar_sub_v4(p_grupo_id, v, 'Fretes', '📦');
  perform public.criar_sub_v4(p_grupo_id, v, 'Embalagens', '📫');

  v := public.criar_cat_v4(p_grupo_id, 'Tecnologia', '📱', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Celular', '📱');
  perform public.criar_sub_v4(p_grupo_id, v, 'Aplicativos', '📲');
  perform public.criar_sub_v4(p_grupo_id, v, 'Cloud Storage', '☁️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Licenças', '🔑');

  v := public.criar_cat_v4(p_grupo_id, 'Família', '👨‍👩‍👧', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Filhos', '🧒');
  perform public.criar_sub_v4(p_grupo_id, v, 'Escola', '🏫');
  perform public.criar_sub_v4(p_grupo_id, v, 'Mesada', '💸');
  perform public.criar_sub_v4(p_grupo_id, v, 'Pets', '🐶');

  v := public.criar_cat_v4(p_grupo_id, 'Financeiro', '💰', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Juros', '📈');
  perform public.criar_sub_v4(p_grupo_id, v, 'Tarifas bancárias', '🏦');
  perform public.criar_sub_v4(p_grupo_id, v, 'IOF', '🧾');
  perform public.criar_sub_v4(p_grupo_id, v, 'Impostos', '🏛️');
  perform public.criar_sub_v4(p_grupo_id, v, 'Empréstimos', '🤝');
  perform public.criar_sub_v4(p_grupo_id, v, 'Financiamentos', '🏦');
  perform public.criar_sub_v4(p_grupo_id, v, 'Investimentos', '📊');
  perform public.criar_sub_v4(p_grupo_id, v, 'Previdência', '🛡️');

  v := public.criar_cat_v4(p_grupo_id, 'Doações', '❤️', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Igreja', '⛪');
  perform public.criar_sub_v4(p_grupo_id, v, 'ONGs', '🌱');
  perform public.criar_sub_v4(p_grupo_id, v, 'Caridade', '🤲');

  v := public.criar_cat_v4(p_grupo_id, 'Outros', '📦', 'despesa');
  perform public.criar_sub_v4(p_grupo_id, v, 'Diversos', '🧩');
  perform public.criar_sub_v4(p_grupo_id, v, 'Emergências', '🚨');

  -- ═══════ RECEITAS ═══════
  v := public.criar_cat_v4(p_grupo_id, 'Trabalho', '💼', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Salário', '💵', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Horas extras', '⏰', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Comissão', '🤝', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Bonificação', '🎉', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, '13º salário', '🎄', 'receita');

  v := public.criar_cat_v4(p_grupo_id, 'Negócio', '🚀', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Venda de produtos', '🛍️', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Venda de serviços', '🛠️', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Freelance', '💻', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Consultoria', '👔', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Receita recorrente', '🔁', 'receita');

  v := public.criar_cat_v4(p_grupo_id, 'Investimentos', '💸', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Dividendos', '💹', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Juros', '🪙', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Rendimentos', '📊', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Aluguéis', '🏘️', 'receita');

  v := public.criar_cat_v4(p_grupo_id, 'Extras', '🎁', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Presente recebido', '🎁', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Cashback', '💸', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Reembolso', '↩️', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Restituição de IR', '🧾', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Prêmios', '🏆', 'receita');

  v := public.criar_cat_v4(p_grupo_id, 'Transferências', '🔄', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Transferência recebida', '📥', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Empréstimo recebido', '💵', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'PIX', '⚡', 'receita');
  perform public.criar_sub_v4(p_grupo_id, v, 'Boleto', '📄', 'receita');
end; $$;

-- ── 4) Backfill em todos os grupos ────────────────────────────────────
do $$
declare g record;
begin
  for g in select id from public.grupos loop
    perform public.criar_categorias_padrao(g.id);
  end loop;
end; $$;

-- ── 5) Remapeia transações antigas → nomes novos (nome puro OU "emoji nome") ──
do $$
declare r record;
begin
  for r in (values
      ('Mercado',                '🛒 Supermercado'),
      ('Contas',                 '🏠 Moradia'),
      ('Vestuário',              '🛍️ Compras'),
      ('Beleza',                 '🧼 Autocuidado'),
      ('Médico',                 '🩺 Consultas'),
      ('Casa',                   '🛍️ Compras'),
      ('Vendas',                 '🚀 Negócio'),
      ('Lazer e Entretenimento', '🎮 Lazer'),
      ('Trabalho/Negócio',       '💼 Empreendimento'),
      ('Pet',                    '🐶 Pets')
    ) as t(velho, novo)
  loop
    update public.transacoes set categoria = r.novo
     where lower(categoria) = lower(r.velho) or categoria ilike '% ' || r.velho;
  end loop;
end $$;

-- =====================================================================
-- Verificação:
--   select nome, icone, tipo from public.categorias
--    where grupo_id = '<seu_grupo>' and parent_id is null order by tipo, nome;
--   -- 21 despesa + 5 receita, sem duplicata; "Juros"/"Investimentos" aparecem
--   -- 2x (pais diferentes), o que agora é permitido.
-- =====================================================================
