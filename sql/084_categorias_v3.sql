-- =====================================================================
-- 084 — Categorias v3: taxonomia nova completa (despesas + receitas)
--
-- ADITIVO e idempotente: só cria o que falta. NUNCA apaga/dropa categoria —
-- o que o usuário criou fica intacto. Reusa os helpers criar_categoria_pai
-- (072) e cria criar_sub_tipo (aceita tipo p/ subs de receita).
--
-- `criar_categorias_padrao` passa a SER a v3 → novos cadastros nascem já na v3
-- limpa; o backfill abaixo aplica a v3 (aditiva) a todos os grupos existentes.
--
-- CONVENÇÃO: `nome` SEM emoji, `icone` leva o emoji.
--
-- Colisões resolvidas (a unique é (grupo_id, nome) — nome único no grupo TODO):
--   · Investimentos (receita, topo) mantém o nome; a sub de Financeiro (aporte)
--     não é criada (aporte vive na aba Investimentos).
--   · Juros: Financeiro='Juros'; Investimentos(receita)='Juros recebidos'.
--   · Financiamento (Moradia) × Financiamentos (Financeiro) — nomes distintos.
--   · 'Pet' (não 'Pets') e 'Viagem' (não 'Viagens') p/ casar com o categorizador.
-- =====================================================================

-- ── Helper: categoria PAI com ícone + tipo (idêntico ao da 072; incluído
--    aqui pra a 084 ser autossuficiente se rodada isolada) ──────────────
create or replace function public.criar_categoria_pai(
  p_grupo_id uuid,
  p_nome     text,
  p_icone    text,
  p_tipo     text default 'despesa',
  p_match    text default null
)
returns uuid
language plpgsql
as $$
declare
  v_id    uuid;
  v_match text := coalesce(p_match, '%' || p_nome || '%');
begin
  select id into v_id
    from public.categorias
   where grupo_id = p_grupo_id and parent_id is null
     and nome ilike v_match and coalesce(ativa, true) = true
   limit 1;
  if v_id is not null then return v_id; end if;

  select id into v_id
    from public.categorias
   where grupo_id = p_grupo_id and lower(btrim(nome)) = lower(btrim(p_nome))
   limit 1;
  if v_id is not null then return v_id; end if;

  insert into public.categorias (grupo_id, nome, parent_id, icone, cor, tipo, ativa)
  values (p_grupo_id, p_nome, null, p_icone, '#808080', p_tipo, true)
  returning id into v_id;
  return v_id;
end;
$$;

-- ── Helper: subcategoria com ícone E tipo (a 072 fixava 'despesa') ────
create or replace function public.criar_sub_tipo(
  p_grupo_id uuid,
  p_parent   uuid,
  p_nome     text,
  p_icone    text,
  p_tipo     text default 'despesa'
)
returns void
language plpgsql
as $$
begin
  if p_parent is null then return; end if;
  -- unique é (grupo_id, nome) → checa o NOME no grupo inteiro. Se já existe em
  -- qualquer lugar (topo/outra pai/inativa), não duplica.
  if exists (
    select 1 from public.categorias
     where grupo_id = p_grupo_id
       and lower(btrim(nome)) = lower(btrim(p_nome))
  ) then
    return;
  end if;
  insert into public.categorias (grupo_id, nome, parent_id, icone, cor, tipo, ativa)
  values (p_grupo_id, p_nome, p_parent, p_icone, '#808080', p_tipo, true);
end;
$$;

-- ── criar_categorias_padrao := taxonomia v3 completa ─────────────────
create or replace function public.criar_categorias_padrao(p_grupo_id uuid)
returns void
language plpgsql
as $$
declare
  v uuid;
begin
  -- ═══════════════ DESPESAS ═══════════════

  -- 🏠 Moradia
  v := public.criar_categoria_pai(p_grupo_id, 'Moradia', '🏠', 'despesa', '%morad%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Aluguel', '🔑');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Financiamento', '🏦');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Condomínio', '🏢');
  perform public.criar_sub_tipo(p_grupo_id, v, 'IPTU', '🧾');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Água', '🚰');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Conta de Luz', '⚡');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Gás', '🔥');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Internet', '🌐');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Manutenção', '🔨');

  -- 🍔 Alimentação
  v := public.criar_categoria_pai(p_grupo_id, 'Alimentação', '🍔', 'despesa', '%aliment%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Supermercado', '🛒');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Padaria', '🥖');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Restaurante', '🍽️');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Lanches', '🌮');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Café', '☕');

  -- 🛵 Delivery (marcas)
  v := public.criar_categoria_pai(p_grupo_id, 'Delivery', '🛵', 'despesa', 'Delivery');
  perform public.criar_sub_tipo(p_grupo_id, v, 'iFood', '🛵');
  perform public.criar_sub_tipo(p_grupo_id, v, 'AiqFome', '🛵');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Zé Delivery', '🍺');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Rappi', '🛵');

  -- 🚗 Transporte
  v := public.criar_categoria_pai(p_grupo_id, 'Transporte', '🚗', 'despesa', '%transport%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Combustível', '⛽');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Uber', '🚗');
  perform public.criar_sub_tipo(p_grupo_id, v, '99', '🚗');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Blablacar', '🚗');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Táxi', '🚖');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Ônibus', '🚌');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Metrô', '🚇');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Pedágio', '🛣️');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Estacionamento', '🅿️');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Manutenção do veículo', '🔧');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Seguro do veículo', '🛡️');

  -- 🏥 Saúde
  v := public.criar_categoria_pai(p_grupo_id, 'Saúde', '🏥', 'despesa', '%sa_de%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Farmácia', '💊');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Plano de Saúde', '❤️‍🩹');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Consultas', '🩺');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Exames', '🧪');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Psicólogo', '🧠');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Dentista', '🦷');

  -- 🏋️ Academia (sem subs)
  perform public.criar_categoria_pai(p_grupo_id, 'Academia', '🏋️', 'despesa', '%academia%');

  -- 🛍️ Compras
  v := public.criar_categoria_pai(p_grupo_id, 'Compras', '🛍️', 'despesa', '%compras%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Roupas', '👕');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Calçados', '👟');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Acessórios', '⌚');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Eletrônicos', '💻');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Móveis', '🛋️');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Casa e decoração', '🏡');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Presente', '🎁');

  -- 🚚 Encomendas (marcas)
  v := public.criar_categoria_pai(p_grupo_id, 'Encomendas', '🚚', 'despesa', '%encomendas%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Aliexpress', '📦');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Amazon', '📦');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Shopee', '📦');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Mercado Livre', '📦');
  perform public.criar_sub_tipo(p_grupo_id, v, 'TikTok Shop', '📦');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Adidas', '👟');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Nike', '👟');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Shein', '👗');

  -- 🧼 Autocuidado
  v := public.criar_categoria_pai(p_grupo_id, 'Autocuidado', '🧼', 'despesa', '%autocuidado%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Salão de beleza', '💇');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Barbeiro', '💈');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Manicure', '💅');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Skincare', '🧴');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Maquiagem', '💄');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Perfume', '🌸');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Tatuagem', '🖋️');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Piercing', '💎');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Massagem', '💆');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Spa', '🧖');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Higiene Pessoal', '🪥');

  -- 🍎 Dieta
  v := public.criar_categoria_pai(p_grupo_id, 'Dieta', '🍎', 'despesa', 'Dieta');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Suplementos', '🥛');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Whey Protein', '💪');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Creatina', '⚡');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Hipercalórico', '🥤');
  perform public.criar_sub_tipo(p_grupo_id, v, 'BCAA', '🧬');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Pré-Treino', '🔥');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Vitaminas', '🍊');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Isotônico', '🧃');

  -- 🎮 Lazer
  v := public.criar_categoria_pai(p_grupo_id, 'Lazer', '🎮', 'despesa', '%lazer%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Cinema', '🎬');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Streaming', '📺');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Jogos', '🎮');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Viagem', '✈️');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Eventos', '🎟️');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Bares', '🍺');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Festas', '🎉');

  -- 🏃 Esporte
  v := public.criar_categoria_pai(p_grupo_id, 'Esporte', '🏃', 'despesa', 'Esporte');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Futebol', '⚽');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Basquete', '🏀');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Futevôlei', '🏖️');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Vôlei', '🏐');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Tênis', '🎾');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Beach Tennis', '🏓');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Artes Marciais', '🥋');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Natação', '🏊');

  -- 🎞️ Assinaturas (marcas)
  v := public.criar_categoria_pai(p_grupo_id, 'Assinaturas', '🎞️', 'despesa', '%assinatura%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Disney+', '📺');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Globo Play', '📺');
  perform public.criar_sub_tipo(p_grupo_id, v, 'HBO Max', '📺');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Netflix', '📺');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Prime Video', '📺');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Spotify', '🎵');

  -- 📚 Educação
  v := public.criar_categoria_pai(p_grupo_id, 'Educação', '📚', 'despesa', '%educa%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Cursos', '🎓');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Faculdade', '🏫');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Livros', '📖');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Material escolar', '✏️');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Idiomas', '🌍');

  -- 💼 Trabalho / Negócio (despesa)
  v := public.criar_categoria_pai(p_grupo_id, 'Trabalho/Negócio', '💼', 'despesa', '%trabalho%neg%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Marketing e Publicidade', '📣');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Facebook Ads', '📣');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Google Ads', '📣');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Ferramentas', '🧰');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Softwares', '💻');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Hospedagem', '🖥️');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Domínio', '🌐');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Equipamentos', '🖨️');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Fornecedores', '🚚');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Fretes', '📦');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Embalagens', '📫');

  -- 📱 Tecnologia
  v := public.criar_categoria_pai(p_grupo_id, 'Tecnologia', '📱', 'despesa', 'Tecnologia');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Celular', '📱');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Aplicativos', '📲');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Cloud Storage', '☁️');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Licenças', '🔑');

  -- 👨‍👩‍👧 Família
  v := public.criar_categoria_pai(p_grupo_id, 'Família', '👨‍👩‍👧', 'despesa', 'Família');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Filhos', '🧒');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Escola', '🏫');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Mesada', '💸');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Pet', '🐶');

  -- 💰 Financeiro
  v := public.criar_categoria_pai(p_grupo_id, 'Financeiro', '💰', 'despesa', 'Financeiro');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Juros', '📈');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Tarifas bancárias', '🏦');
  perform public.criar_sub_tipo(p_grupo_id, v, 'IOF', '🧾');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Impostos', '🏛️');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Empréstimos', '🤝');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Financiamentos', '💳');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Previdência', '🛡️');

  -- ❤️ Doações
  v := public.criar_categoria_pai(p_grupo_id, 'Doações', '❤️', 'despesa', 'Doações');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Igreja', '⛪');
  perform public.criar_sub_tipo(p_grupo_id, v, 'ONGs', '🌱');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Caridade', '🤲');

  -- 📦 Outros
  v := public.criar_categoria_pai(p_grupo_id, 'Outros', '📦', 'despesa', '%outros%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Diversos', '🧩');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Emergências', '🚨');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Não categorizado', '❓');

  -- ═══════════════ RECEITAS ═══════════════

  -- 💼 Trabalho
  v := public.criar_categoria_pai(p_grupo_id, 'Trabalho', '💼', 'receita', 'Trabalho');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Salário', '💵', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Horas extras', '⏰', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Comissão', '🤝', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Bonificação', '🎉', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, '13º salário', '🎄', 'receita');

  -- 🚀 Negócio
  v := public.criar_categoria_pai(p_grupo_id, 'Negócio', '🚀', 'receita', 'Negócio');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Venda de produtos', '🛍️', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Venda de serviços', '🛠️', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Freelance', '💻', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Consultoria', '👔', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Receita recorrente', '🔁', 'receita');

  -- 💸 Investimentos (receita)
  v := public.criar_categoria_pai(p_grupo_id, 'Investimentos', '💸', 'receita', 'Investimentos');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Dividendos', '💹', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Juros recebidos', '🪙', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Rendimentos', '📊', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Aluguéis', '🏘️', 'receita');

  -- 🎁 Extras
  v := public.criar_categoria_pai(p_grupo_id, 'Extras', '🎁', 'receita', '%extras%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Presente recebido', '🎁', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Cashback', '💸', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Reembolso', '↩️', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Restituição de IR', '🧾', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Prêmios', '🏆', 'receita');

  -- 🔄 Transferências
  v := public.criar_categoria_pai(p_grupo_id, 'Transferências', '🔄', 'receita', '%transfer%');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Transferência recebida', '📥', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Empréstimo recebido', '💵', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'PIX', '⚡', 'receita');
  perform public.criar_sub_tipo(p_grupo_id, v, 'Boleto', '📄', 'receita');
end;
$$;

-- ── Trigger de signup: novos usuários nascem SÓ com a v3 limpa ────────
-- (a 030 fazia padrão + extra; agora padrão JÁ é a v3 completa.)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grupo_id uuid;
  v_name     text;
begin
  v_name := coalesce(
    new.raw_user_meta_data->>'name',
    new.raw_user_meta_data->>'full_name',
    split_part(coalesce(new.email, ''), '@', 1),
    'Usuário'
  );
  insert into public.users (id, name, email, phone, plano)
  values (new.id, v_name, coalesce(new.email, ''), null, 'inativo')
  on conflict (id) do nothing;
  insert into public.grupos (nome, dono_id)
  values ('Pessoal de ' || v_name, new.id)
  returning id into v_grupo_id;
  update public.users set grupo_ativo = v_grupo_id where id = new.id;
  perform public.criar_categorias_padrao(v_grupo_id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Backfill: aplica a v3 (aditiva) a todos os grupos existentes ──────
do $$
declare g record;
begin
  for g in select id from public.grupos loop
    perform public.criar_categorias_padrao(g.id);
  end loop;
end;
$$;

-- =====================================================================
-- Verificação:
--   select nome, icone, tipo from public.categorias
--    where grupo_id = '<seu_grupo>' and parent_id is null order by tipo, nome;
-- =====================================================================
