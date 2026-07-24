-- =====================================================================
-- 093 — Resetar conta (limpar dados por módulo, SEM excluir a conta)
--
-- Um cliente pediu pra "resetar" a conta: limpar os dados pra reorganizar
-- do zero, mantendo login, plano e WhatsApp. Diferente de excluir a conta.
--
-- A limpeza é MODULAR (o usuário escolhe o que apagar):
--   • p_financas  → transações, contas, cartões, metas, dívidas,
--                   investimentos, limites, recorrências, marcas.
--                   Recria as categorias PADRÃO no fim.
--   • p_negocios  → aba Negócios (empresas, caixa, folha, DRE, integrações).
--   • p_grow      → Sora Grow do PRÓPRIO usuário (hábitos, tarefas, saúde,
--                   estudos, agenda, casa, notas, Drive, bíblia).
--   • p_colecoes  → coleções (viagens/mídia/leituras/bucket_list). São
--                   compartilhadas por grupo → só passar true em grupo solo.
--
-- ESCOPO/PRIVACIDADE:
--   Finanças e Negócios são por grupo_id (compartilhados casal/família).
--   O backend BLOQUEIA resetar esses módulos em conta compartilhada.
--   Grow é por user_id → apaga só os dados DA PESSOA (seguro em grupo).
--
-- Transacional por natureza (função roda numa transação) → ou apaga tudo
-- do que foi pedido, ou nada. Nunca toca em users, grupos, grupo_membros
-- nem of_conexoes/pluggy_items (mantém o vínculo bancário).
--
-- DEFENSIVA: cada delete só roda se a tabela/coluna existir (migrations
-- podem não ter rodado). Filhos com ON DELETE CASCADE são limpos ao apagar
-- o pai — por isso a lista abaixo tem só as tabelas "raiz".
--
-- Aplicar: Supabase → SQL Editor → Run. Idempotente.
-- =====================================================================

-- Helper: apaga de uma tabela por uma coluna = valor, só se ambos existirem.
create or replace function public._reset_del(p_table text, p_col text, p_val uuid)
returns void
language plpgsql
as $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = p_table and column_name = p_col
  ) then
    execute format('delete from public.%I where %I = $1', p_table, p_col) using p_val;
  end if;
end;
$$;

create or replace function public.resetar_conta(
  p_grupo_id  uuid,
  p_user_id   uuid,
  p_financas  boolean default false,
  p_negocios  boolean default false,
  p_grow      boolean default false,
  p_colecoes  boolean default false
)
returns void
language plpgsql
security definer
as $$
begin
  -- ── FINANÇAS (grupo_id) ─────────────────────────────────────────────
  if p_financas then
    -- filhos com cascade (meta_aportes, divida_pagamentos) somem com o pai
    perform public._reset_del('transacoes',                'grupo_id', p_grupo_id);
    perform public._reset_del('wallets',                   'grupo_id', p_grupo_id);
    perform public._reset_del('category_limits',           'grupo_id', p_grupo_id);
    perform public._reset_del('metas',                     'grupo_id', p_grupo_id);
    perform public._reset_del('dividas',                   'grupo_id', p_grupo_id);
    perform public._reset_del('aportes',                   'grupo_id', p_grupo_id);
    perform public._reset_del('patrimonio_historico',      'grupo_id', p_grupo_id);
    perform public._reset_del('reserva_emergencia_config', 'grupo_id', p_grupo_id);
    perform public._reset_del('investimentos',             'grupo_id', p_grupo_id);
    perform public._reset_del('recorrencias_dispensadas',  'grupo_id', p_grupo_id);
    perform public._reset_del('recorrencias',              'grupo_id', p_grupo_id);
    perform public._reset_del('eventos_financeiros',       'grupo_id', p_grupo_id);
    perform public._reset_del('marcas_personalizadas',     'grupo_id', p_grupo_id);
    -- estado de conversa do WhatsApp (efêmero, por usuário)
    perform public._reset_del('transacoes_pendentes',      'user_id',  p_user_id);
    -- categorias: apaga e recria as padrão (a taxonomia base, limpa)
    perform public._reset_del('categorias',                'grupo_id', p_grupo_id);
    perform public.criar_categorias_padrao(p_grupo_id);
  end if;

  -- ── NEGÓCIOS (grupo_id / empresa_id) ────────────────────────────────
  if p_negocios then
    -- tabelas por empresa_id (filhas das empresas) primeiro
    begin
      delete from public.lancamentos_negocio
        where empresa_id in (select id from public.empresas where grupo_id = p_grupo_id);
    exception when undefined_table or undefined_column then null; end;
    begin
      delete from public.funcionarios_negocio
        where empresa_id in (select id from public.empresas where grupo_id = p_grupo_id);
    exception when undefined_table or undefined_column then null; end;

    perform public._reset_del('conciliacao_negocio', 'user_id',  p_user_id);
    perform public._reset_del('dre_snapshots',       'grupo_id', p_grupo_id);
    perform public._reset_del('insights_negocio',    'grupo_id', p_grupo_id);
    perform public._reset_del('integracoes',         'grupo_id', p_grupo_id);
    perform public._reset_del('custos_negocio',      'grupo_id', p_grupo_id);
    perform public._reset_del('config_negocio',      'grupo_id', p_grupo_id);
    perform public._reset_del('empresas',            'grupo_id', p_grupo_id);
  end if;

  -- ── SORA GROW (user_id — só os dados DA PESSOA) ─────────────────────
  if p_grow then
    -- Hábitos / tarefas / agenda / notas
    perform public._reset_del('registros_habito', 'user_id', p_user_id); -- caso não caia no cascade
    perform public._reset_del('habitos',          'user_id', p_user_id);
    perform public._reset_del('tarefas',          'user_id', p_user_id);
    perform public._reset_del('projetos',         'user_id', p_user_id);
    perform public._reset_del('compromissos',     'user_id', p_user_id);
    perform public._reset_del('notas',            'user_id', p_user_id);
    perform public._reset_del('rotina_blocos',    'user_id', p_user_id);

    -- Saúde
    perform public._reset_del('medicamentos',    'user_id', p_user_id); -- cascade doses
    perform public._reset_del('treinos',         'user_id', p_user_id); -- cascade registros
    perform public._reset_del('consultas',       'user_id', p_user_id);
    perform public._reset_del('exames',          'user_id', p_user_id);
    perform public._reset_del('vacinas',         'user_id', p_user_id);
    perform public._reset_del('ciclo_menstrual', 'user_id', p_user_id);
    perform public._reset_del('agua_registros',  'user_id', p_user_id);
    perform public._reset_del('pesos',           'user_id', p_user_id);
    perform public._reset_del('medidas_corporais','user_id', p_user_id);
    perform public._reset_del('fotos_progresso', 'user_id', p_user_id);
    perform public._reset_del('registros_humor', 'user_id', p_user_id);
    perform public._reset_del('refeicoes',       'user_id', p_user_id); -- cascade itens
    perform public._reset_del('metas_nutricao',  'user_id', p_user_id);
    perform public._reset_del('perfil_saude',    'user_id', p_user_id);

    -- Estudos
    perform public._reset_del('sessoes_estudo',   'user_id', p_user_id);
    perform public._reset_del('provas',           'user_id', p_user_id);
    perform public._reset_del('anotacoes_estudo', 'user_id', p_user_id);
    perform public._reset_del('metas_estudo',     'user_id', p_user_id);
    perform public._reset_del('disciplinas',      'user_id', p_user_id);
    perform public._reset_del('cursos',           'user_id', p_user_id); -- cascade disciplinas/provas/sessoes

    -- Casa
    perform public._reset_del('itens_lista_compras', 'user_id', p_user_id);
    perform public._reset_del('listas_compras',      'user_id', p_user_id); -- cascade itens
    perform public._reset_del('despensa_itens',      'user_id', p_user_id);
    perform public._reset_del('manutencoes',         'user_id', p_user_id);
    perform public._reset_del('receita_ingredientes','user_id', p_user_id);
    perform public._reset_del('receitas',            'user_id', p_user_id); -- cascade ingredientes

    -- Bíblia
    perform public._reset_del('biblia_leituras',    'user_id', p_user_id);
    perform public._reset_del('biblia_memorizacao', 'user_id', p_user_id);
    perform public._reset_del('biblia_oracoes',     'user_id', p_user_id);
    perform public._reset_del('biblia_progresso',   'user_id', p_user_id);

    -- Drive (documentos)
    perform public._reset_del('dados_itens',   'user_id', p_user_id);
    perform public._reset_del('dados_secoes',  'user_id', p_user_id);
    perform public._reset_del('dados_quadros', 'user_id', p_user_id); -- cascade secoes/itens
  end if;

  -- ── COLEÇÕES (grupo_id — compartilhadas; só em grupo solo) ──────────
  if p_colecoes then
    perform public._reset_del('viagens',     'grupo_id', p_grupo_id);
    perform public._reset_del('midia',       'grupo_id', p_grupo_id);
    perform public._reset_del('leituras',    'grupo_id', p_grupo_id);
    perform public._reset_del('bucket_list', 'grupo_id', p_grupo_id);
  end if;
end;
$$;

-- =====================================================================
-- Verificação (opcional):
--   select public.resetar_conta(
--     '<grupo_id>'::uuid, '<user_id>'::uuid,
--     p_financas => true, p_grow => false
--   );
-- =====================================================================
