// =============================================================================
// CONTA DE DEMONSTRAÇÃO — dados fictícios pra gravação de anúncio.
//
// Cria (ou repovoa) a conta que as modelos usam pra apresentar o app, com
// Premium vitalício de cortesia.
//
// ⚠️ TRAVADO NO E-MAIL DA DEMO. Todo apagão aqui é escopado ao `grupo_id` dessa
// conta e o script se recusa a rodar em qualquer outro e-mail. É destrutivo por
// natureza (repovoar = apagar antes), e um erro de digitação apagaria a vida
// financeira de um cliente.
//
// ⚠️ NÃO ENTRA NO MRR. `mrr_excluir = true` — é cortesia, não venda. Sem isso
// ela apareceria como receita no /admin (mesma razão da coluna na migration 074).
//
// ── POR QUE AS DATAS SÃO RELATIVAS A HOJE ───────────────────────────────────
// Nada é data fixa. Tudo é calculado a partir do dia da execução, então a demo
// nunca "envelhece": rodando daqui a seis meses, o dashboard continua mostrando
// o mês corrente cheio, hábitos com sequência viva e compromissos à frente. Uma
// gravação com "última transação há 4 meses" entrega que é maquete.
//
// ── POR QUE ESSAS MARCAS ────────────────────────────────────────────────────
// Os nomes de estabelecimento foram escolhidos entre os que TÊM logo em
// `public/brands/` (iFood, Uber, Netflix, Nubank, Shein…). O `IconeMarca` casa
// por nome, então a lista de transações aparece com os ícones coloridos em vez
// de um círculo genérico — é o que faz a tela render em vídeo.
//
// ⚠️ Os nomes de CATEGORIA precisam bater com a taxonomia v4 (`Alimentação`,
// `Delivery`, `Transporte`…). O campo é texto livre; nome fora da lista some da
// aba Categorias e perde o ícone.
//
// Rodar:  node scripts/seed-conta-demo.js
// =============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const EMAIL = 'comercialsora@gmail.com';
const SENHA = 'Sora1234!';
const NOME  = 'Daiane';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ── Datas relativas a hoje, no fuso de São Paulo ────────────────────────────
// ⚠️ `toISOString()` é UTC: depois das 21h no Brasil ele já devolve o dia
// seguinte, e a "transação de hoje" cairia amanhã. Mesma regra do resto do
// backend (`hojeSP`).
const HOJE = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Dia `dia` de `mesesAtras` meses atrás. Clampa ao último dia do mês (dia 31
 *  em fevereiro viraria 3 de março com o construtor cru). */
const dataEm = (mesesAtras, dia) => {
  const base = new Date(HOJE.getFullYear(), HOJE.getMonth() - mesesAtras, 1);
  const ultimo = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate();
  return iso(new Date(base.getFullYear(), base.getMonth(), Math.min(dia, ultimo)));
};
const maisDias = (n) => { const d = new Date(HOJE); d.setDate(d.getDate() + n); return iso(d); };
const diaDeHoje = HOJE.getDate();

const log = (...a) => console.log(...a);

// ═══════════════════════════════════════════════════════════════════════════
// 1. Conta de autenticação
// ═══════════════════════════════════════════════════════════════════════════
async function garantirUsuario() {
  // `listUsers` não filtra por e-mail na v2, então varro as páginas.
  let userId = null;
  for (let page = 1; page <= 20 && !userId; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const achado = (data.users || []).find((u) => (u.email || '').toLowerCase() === EMAIL);
    if (achado) userId = achado.id;
    if (!data.users?.length || data.users.length < 1000) break;
  }

  if (userId) {
    // Já existe: só garante a senha e o nome (a demo pode ser recriada).
    const { error } = await sb.auth.admin.updateUserById(userId, {
      password: SENHA, email_confirm: true, user_metadata: { name: NOME },
    });
    if (error) throw new Error(`updateUser: ${error.message}`);
    log(`· conta de auth já existia — senha e nome reaplicados (${userId})`);
    return userId;
  }

  // ⚠️ `email_confirm: true`: sem isso o Supabase manda e-mail de confirmação
  // e a conta fica pendente. Ninguém vai abrir a caixa dessa conta.
  const { data, error } = await sb.auth.admin.createUser({
    email: EMAIL, password: SENHA, email_confirm: true, user_metadata: { name: NOME },
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  log(`· conta de auth criada (${data.user.id})`);
  return data.user.id;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Perfil + grupo (o trigger do Supabase costuma criar; se não, criamos)
// ═══════════════════════════════════════════════════════════════════════════
async function garantirPerfil(userId) {
  for (let i = 0; i < 10; i++) {
    const { data } = await sb.from('users').select('id, grupo_ativo').eq('id', userId).maybeSingle();
    if (data?.grupo_ativo) return data.grupo_ativo;
    await new Promise((r) => setTimeout(r, 400));
  }

  log('· trigger não criou o perfil — criando à mão');
  const { data: g, error: eg } = await sb.from('grupos')
    .insert({ nome: `Grupo de ${NOME}`, dono_id: userId }).select('id').single();
  if (eg) throw new Error(`grupos: ${eg.message}`);
  const { error: eu } = await sb.from('users')
    .upsert({ id: userId, email: EMAIL, name: NOME, grupo_ativo: g.id }, { onConflict: 'id' });
  if (eu) throw new Error(`users: ${eu.message}`);
  await sb.from('grupo_membros').insert({ grupo_id: g.id, user_id: userId, papel: 'admin' });
  return g.id;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Plano + preferências
// ═══════════════════════════════════════════════════════════════════════════
async function configurarConta(userId) {
  const campos = {
    name: NOME,
    plano: 'premium',            // vitalício "completa" = premium (o Black saiu em 2026)
    vitalicio: true,
    vitalicio_em: new Date().toISOString(),
    vitalicio_valor: 0,          // cortesia
    mrr_excluir: true,           // ⚠️ fora do MRR do /admin — não é venda
    onboarding_completed: true,  // vai direto pro dashboard, sem o wizard
    onboarding_step: 9,
    meta_mensal: 6500,
    meta_mensal_ativo: true,
    perfil_uso: 'pessoal',
    objetivo_principal: 'organizar',
    // Silencia tudo que dispararia mensagem: a conta não tem WhatsApp e não
    // deve entrar em cron de lembrete/resumo.
    lembretes_ativos: false,
    lembretes_dividas: false,
    resumo_semanal: false,
    resumo_mensal: false,
    habito_lembrete_ativo: false,
    agenda_briefing_ativo: false,
    avisos_ativos: false,
  };
  // Grava campo a campo tolerando coluna ausente — o schema muda com o tempo e
  // um `update` inteiro falharia por causa de uma coluna só.
  for (const [k, v] of Object.entries(campos)) {
    const { error } = await sb.from('users').update({ [k]: v }).eq('id', userId);
    if (error) log(`  ⚠️ campo "${k}" não gravou: ${error.message.slice(0, 60)}`);
  }
  log('· plano premium vitalício + preferências aplicados');
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Limpeza (repovoar = apagar o que este script criou antes)
// ═══════════════════════════════════════════════════════════════════════════
async function limpar(grupoId) {
  const tabelas = [
    'registros_habito', 'habitos', 'tarefas', 'compromissos', 'registros_humor',
    'transacoes', 'recorrencias', 'category_limits', 'metas', 'investimentos',
    'divida_pagamentos', 'dividas', 'wallets',
  ];
  for (const t of tabelas) {
    const { error } = await sb.from(t).delete().eq('grupo_id', grupoId);
    if (error && !/does not exist|schema cache/i.test(error.message)) {
      log(`  ⚠️ limpeza de ${t}: ${error.message.slice(0, 60)}`);
    }
  }
  log('· dados anteriores da demo removidos');
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Categorias padrão
// ═══════════════════════════════════════════════════════════════════════════
async function garantirCategorias(grupoId) {
  const { count } = await sb.from('categorias')
    .select('id', { count: 'exact', head: true }).eq('grupo_id', grupoId);
  if (count && count > 5) { log(`· categorias já existiam (${count})`); return; }
  const { error } = await sb.rpc('criar_categorias_padrao', { p_grupo_id: grupoId });
  if (error) log(`  ⚠️ criar_categorias_padrao: ${error.message.slice(0, 80)}`);
  else log('· categorias padrão criadas');
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Contas e cartão
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ NOMES ÚNICOS. Transação aponta pra carteira por `carteira_nome` (texto),
// não por id — duas carteiras "Nubank" fundiriam conta e cartão na visão de
// transações. Por isso o cartão é "Nubank Ultravioleta": nome distinto, e o
// `IconeMarca` ainda casa o logo pelo "nubank" no começo.
const CONTAS = [
  { nome: 'Nubank',   tipo: 'Corrente', saldo: 4238.90 },
  { nome: 'Itaú',     tipo: 'Corrente', saldo: 1876.45 },
  { nome: 'Inter',    tipo: 'Poupança', saldo: 2450.00 },
  { nome: 'Dinheiro', tipo: 'Dinheiro', saldo:  180.00 },
];
const CARTAO = {
  nome: 'Nubank Ultravioleta', tipo: 'Crédito', saldo: 0,
  limite: 8000, dia_fechamento: 3, dia_vencimento: 10, bandeira: 'Mastercard', ultimos4: '4821',
};

async function criarCarteiras(grupoId, userId) {
  const linhas = [...CONTAS, CARTAO].map((c) => ({ ...c, grupo_id: grupoId, criado_por: userId }));
  const { error } = await sb.from('wallets').insert(linhas);
  if (error) throw new Error(`wallets: ${error.message}`);
  log(`· ${linhas.length} carteiras criadas (4 contas + 1 cartão)`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Transações — 3 meses
// ═══════════════════════════════════════════════════════════════════════════
// Molde de um mês, repetido nos 3 com pequena variação de valor: sem isso o
// gráfico sai reta e o "vs mês anterior" mostra 0%.
//   [dia, tipo, categoria, valor, descrição, carteira]
const MES = [
  [ 5, 'Recebimento', 'Trabalho',      7850.00, 'Salário',                'Nubank'],
  [18, 'Recebimento', 'Extras',        1240.00, 'Freela de design',       'Nubank'],
  [ 8, 'Recebimento', 'Investimentos',   96.40, 'Rendimento da poupança', 'Inter'],

  [ 5, 'Gasto', 'Moradia',      1650.00, 'Aluguel',                 'Nubank'],
  [ 7, 'Gasto', 'Moradia',       238.70, 'Conta de luz',            'Nubank'],
  [ 7, 'Gasto', 'Moradia',        89.90, 'Internet',                'Nubank'],
  [12, 'Gasto', 'Moradia',       112.40, 'Conta de água',           'Itaú'],

  [ 3, 'Gasto', 'Alimentação',   412.80, 'Supermercado',            'Nubank Ultravioleta'],
  [16, 'Gasto', 'Alimentação',   287.35, 'Supermercado',            'Nubank Ultravioleta'],
  [24, 'Gasto', 'Alimentação',    64.20, 'Hortifruti',              'Dinheiro'],
  [ 9, 'Gasto', 'Delivery',       58.90, 'iFood',                   'Nubank Ultravioleta'],
  [14, 'Gasto', 'Delivery',       72.40, 'iFood',                   'Nubank Ultravioleta'],
  [21, 'Gasto', 'Delivery',       46.70, 'Rappi',                   'Nubank Ultravioleta'],
  [27, 'Gasto', 'Delivery',       61.30, 'iFood',                   'Nubank Ultravioleta'],

  [ 6, 'Gasto', 'Transporte',     38.90, 'Uber',                    'Nubank Ultravioleta'],
  [13, 'Gasto', 'Transporte',     27.50, 'Uber',                    'Nubank Ultravioleta'],
  [20, 'Gasto', 'Transporte',    198.00, 'Combustível',             'Itaú'],
  [26, 'Gasto', 'Transporte',     42.10, 'Uber',                    'Nubank Ultravioleta'],

  [ 4, 'Gasto', 'Academia',      129.90, 'Academia',                'Nubank'],
  [11, 'Gasto', 'Saúde',         180.00, 'Consulta dermatologista', 'Itaú'],
  [19, 'Gasto', 'Saúde',          94.60, 'Farmácia',                'Nubank Ultravioleta'],
  [22, 'Gasto', 'Autocuidado',   150.00, 'Cabeleireiro',            'Dinheiro'],
  [10, 'Gasto', 'Dieta',         168.40, 'Suplementos',             'Nubank Ultravioleta'],

  [ 2, 'Gasto', 'Assinaturas',    39.90, 'Netflix',                 'Nubank Ultravioleta'],
  [ 2, 'Gasto', 'Assinaturas',    21.90, 'Spotify',                 'Nubank Ultravioleta'],
  [15, 'Gasto', 'Assinaturas',    49.90, 'Prime Video',             'Nubank Ultravioleta'],
  [15, 'Gasto', 'Tecnologia',    109.90, 'ChatGPT',                 'Nubank Ultravioleta'],

  [17, 'Gasto', 'Compras',       229.90, 'Shein',                   'Nubank Ultravioleta'],
  [23, 'Gasto', 'Compras',       349.90, 'Nike',                    'Nubank Ultravioleta'],
  [25, 'Gasto', 'Encomendas',    132.60, 'Amazon',                  'Nubank Ultravioleta'],
  [28, 'Gasto', 'Encomendas',     78.40, 'Mercado Livre',           'Nubank Ultravioleta'],

  [ 8, 'Gasto', 'Lazer',          96.00, 'Cinema',                  'Nubank Ultravioleta'],
  [22, 'Gasto', 'Lazer',         185.00, 'Restaurante',             'Nubank Ultravioleta'],
  [29, 'Gasto', 'Educação',      197.00, 'Curso de inglês',         'Nubank'],
  [ 1, 'Gasto', 'Família',       200.00, 'Mesada da sobrinha',      'Nubank'],
  [30, 'Gasto', 'Doações',        50.00, 'Doação mensal',           'Nubank'],
];

async function criarTransacoes(grupoId, userId) {
  const fator = [1.00, 0.94, 0.88];          // [mês atual, -1, -2]
  const linhas = [];
  for (let m = 0; m < 3; m++) {
    for (const [dia, tipo, categoria, valor, obs, carteira] of MES) {
      // ⚠️ No mês corrente, nada de data futura: transação à frente não é
      // "gasto que já aconteceu" e inflaria o total do mês na gravação.
      if (m === 0 && dia > diaDeHoje) continue;
      linhas.push({
        grupo_id: grupoId, criado_por: userId,
        tipo, categoria, valor: Math.round(valor * fator[m] * 100) / 100,
        observacao: obs, carteira_nome: carteira, data: dataEm(m, dia), pago: true,
      });
    }
  }
  const { error } = await sb.from('transacoes').insert(linhas);
  if (error) throw new Error(`transacoes: ${error.message}`);
  log(`· ${linhas.length} transações em 3 meses`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Metas, investimentos, dívida, recorrências e limites
// ═══════════════════════════════════════════════════════════════════════════
async function criarFinanceiro(grupoId, userId) {
  const metas = [
    { titulo: 'Viagem pra Noronha',    valor_objetivo: 12000, valor_atual:  7450, icone: '🏝️', cor: '#0EA5E9', data_alvo: dataEm(-8, 15) },
    { titulo: 'Reserva de emergência', valor_objetivo: 30000, valor_atual: 18600, icone: '🛡️', cor: '#65A30D', data_alvo: dataEm(-14, 1) },
    { titulo: 'MacBook novo',          valor_objetivo: 14000, valor_atual:  3280, icone: '💻', cor: '#7C3AED', data_alvo: dataEm(-10, 20) },
  ].map((m) => ({ ...m, grupo_id: grupoId, criado_por: userId, status: 'ativo' }));
  const { error: em } = await sb.from('metas').insert(metas);
  if (em) log(`  ⚠️ metas: ${em.message.slice(0, 70)}`); else log(`· ${metas.length} metas`);

  const invs = [
    { tipo: 'Tesouro Direto', nome: 'Tesouro Selic 2029', valor_aportado: 12000, valor_atual: 13180.40, rentabilidade: 9.84 },
    { tipo: 'CDB',            nome: 'CDB Inter 110% CDI', valor_aportado:  8000, valor_atual:  8642.10, rentabilidade: 8.03, taxa_anual: 11.2, indexador: 'CDI', percentual_indexador: 110 },
    { tipo: 'FIIs',           nome: 'MXRF11', ticker: 'MXRF11', quantidade: 320, preco_unitario: 10.42, valor_aportado: 3334.40, valor_atual: 3520.00, rentabilidade: 5.57 },
    { tipo: 'Ações',          nome: 'ITSA4',  ticker: 'ITSA4',  quantidade: 200, preco_unitario:  9.85, valor_aportado: 1970.00, valor_atual: 2148.00, rentabilidade: 9.04 },
    { tipo: 'Cripto',         nome: 'Bitcoin', ticker: 'BTC', quantidade: 0.012, valor_aportado: 4200, valor_atual: 5310.80, rentabilidade: 26.45 },
    { tipo: 'Caixa',          nome: 'Reserva no Inter', valor_aportado: 2450, valor_atual: 2450, rentabilidade: 0, is_reserva_emergencia: true },
  ].map((i) => ({ ...i, grupo_id: grupoId, data_compra: dataEm(6, 10) }));
  const { error: ei } = await sb.from('investimentos').insert(invs);
  if (ei) log(`  ⚠️ investimentos: ${ei.message.slice(0, 70)}`); else log(`· ${invs.length} investimentos`);

  // Uma dívida só, e saudável: a aba vazia parece feature quebrada, e uma
  // dívida grande contradiz a mensagem do anúncio.
  const { error: ed } = await sb.from('dividas').insert({
    grupo_id: grupoId, criado_por: userId, titulo: 'Financiamento do carro',
    credor: 'Banco Itaú', tipo: 'financiamento', valor_total: 38400, valor_parcela: 800,
    parcelas_total: 48, parcelas_pagas: 19, taxa_juros: 1.29, dia_vencimento: 10,
    data_inicio: dataEm(19, 10), status: 'ativa', lembretes_ativos: false,
  });
  if (ed) log(`  ⚠️ dividas: ${ed.message.slice(0, 70)}`); else log('· 1 dívida');

  const recs = [
    { tipo: 'Gasto',       categoria: 'Moradia',     valor: 1650.00, dia_vencimento: 5, descricao: 'Aluguel',      carteira: 'Nubank' },
    { tipo: 'Gasto',       categoria: 'Moradia',     valor:  238.70, dia_vencimento: 7, descricao: 'Conta de luz', carteira: 'Nubank', valor_variavel: true },
    { tipo: 'Gasto',       categoria: 'Assinaturas', valor:   39.90, dia_vencimento: 2, descricao: 'Netflix',      carteira: 'Nubank Ultravioleta' },
    { tipo: 'Gasto',       categoria: 'Academia',    valor:  129.90, dia_vencimento: 4, descricao: 'Academia',     carteira: 'Nubank' },
    { tipo: 'Recebimento', categoria: 'Trabalho',    valor: 7850.00, dia_vencimento: 5, descricao: 'Salário',      carteira: 'Nubank' },
    // ⚠️ `valor_variavel` é NOT NULL — precisa vir explícito em TODAS as
    // linhas. Deixá-lo só na conta de luz derrubava o insert do lote inteiro.
  ].map((r) => ({
    valor_variavel: false,
    ...r,
    grupo_id: grupoId, criado_por: userId, ativa: true, modo_lancamento: 'lancar',
  }));
  const { error: er } = await sb.from('recorrencias').insert(recs);
  if (er) log(`  ⚠️ recorrencias: ${er.message.slice(0, 70)}`); else log(`· ${recs.length} recorrências`);

  const ym = `${HOJE.getFullYear()}-${String(HOJE.getMonth() + 1).padStart(2, '0')}`;
  const lims = [
    { categoria: 'Delivery',    limite_mensal: 300 },
    { categoria: 'Compras',     limite_mensal: 600 },
    { categoria: 'Alimentação', limite_mensal: 900 },
    { categoria: 'Lazer',       limite_mensal: 400 },
    { categoria: 'Transporte',  limite_mensal: 350 },
  ].map((l) => ({ ...l, grupo_id: grupoId, mes_referencia: ym, percentual_alerta: 80, ativo: true }));
  const { error: el } = await sb.from('category_limits').insert(lims);
  if (el) log(`  ⚠️ category_limits: ${el.message.slice(0, 70)}`); else log(`· ${lims.length} limites de gasto`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Sora Grow — hábitos, tarefas, agenda, humor
// ═══════════════════════════════════════════════════════════════════════════
async function criarGrow(grupoId, userId) {
  const defs = [
    { nome: 'Beber 2L de água', icone: '💧', cor: '#0EA5E9', taxa: 0.90 },
    { nome: 'Academia',         icone: '💪', cor: '#F97316', taxa: 0.75 },
    { nome: 'Ler 20 minutos',   icone: '📚', cor: '#7C3AED', taxa: 0.70 },
    { nome: 'Skincare',         icone: '✨', cor: '#EC4899', taxa: 0.85 },
    { nome: 'Estudar inglês',   icone: '🗽', cor: '#65A30D', taxa: 0.65 },
  ];
  const { data: habitos, error: eh } = await sb.from('habitos').insert(
    defs.map((h, i) => ({
      grupo_id: grupoId, user_id: userId, nome: h.nome, icone: h.icone, cor: h.cor,
      frequencia: 'diario', tipo: 'construir', ativo: true, ordem: i,
    })),
  ).select('id, nome');
  if (eh) { log(`  ⚠️ habitos: ${eh.message.slice(0, 70)}`); return; }

  // 30 dias de histórico. DETERMINÍSTICO (sem Math.random): gravação refeita
  // não pode mostrar outro gráfico.
  const regs = [];
  for (const h of habitos) {
    const taxa = defs.find((d) => d.nome === h.nome).taxa;
    for (let d = 29; d >= 0; d--) {
      const dt = new Date(HOJE); dt.setDate(dt.getDate() - d);
      const semente = (dt.getDate() * 7 + dt.getMonth() * 31 + h.nome.length * 13) % 100;
      // ⚠️ HOJE FICA PROPOSITALMENTE INCOMPLETO — os dois últimos hábitos ficam
      // em aberto. Com 5 de 5 marcados a modelo não tem o que tocar na câmera,
      // e a interação é justamente o que o anúncio precisa mostrar.
      const ultimosDois = defs.slice(-2).some((x) => x.nome === h.nome);
      if (d === 0 && ultimosDois) continue;
      if (semente < taxa * 100) {
        regs.push({ habito_id: h.id, grupo_id: grupoId, user_id: userId, data: iso(dt), concluido: true });
      }
    }
  }
  const { error: er } = await sb.from('registros_habito').insert(regs);
  if (er) log(`  ⚠️ registros_habito: ${er.message.slice(0, 70)}`);
  else log(`· ${habitos.length} hábitos com ${regs.length} check-ins em 30 dias`);

  const tarefas = [
    { titulo: 'Enviar proposta pro cliente novo', prioridade: 'alta',  categoria: 'Trabalho',   data_vencimento: maisDias(1) },
    { titulo: 'Renovar o seguro do carro',        prioridade: 'alta',  categoria: 'Financeiro', data_vencimento: maisDias(4) },
    { titulo: 'Marcar dentista',                  prioridade: 'media', categoria: 'Saúde',      data_vencimento: maisDias(6) },
    { titulo: 'Comprar presente da Bia',          prioridade: 'media', categoria: 'Compras',    data_vencimento: maisDias(9) },
    { titulo: 'Organizar as fotos da viagem',     prioridade: 'baixa', categoria: 'Casa',       data_vencimento: maisDias(14) },
    { titulo: 'Pagar o IPVA',                     prioridade: 'alta',  categoria: 'Financeiro', concluida: true },
  ].map((t) => ({ ...t, grupo_id: grupoId, user_id: userId, criado_por: userId, concluida: !!t.concluida }));
  const { error: et } = await sb.from('tarefas').insert(tarefas);
  if (et) log(`  ⚠️ tarefas: ${et.message.slice(0, 70)}`); else log(`· ${tarefas.length} tarefas`);

  const comps = [
    { titulo: 'Reunião com o cliente', data: maisDias(1),  hora: '10:00', categoria: 'Trabalho', cor: '#0EA5E9' },
    { titulo: 'Aula de inglês',        data: maisDias(2),  hora: '19:30', categoria: 'Estudos',  cor: '#65A30D' },
    { titulo: 'Dermatologista',        data: maisDias(5),  hora: '15:00', categoria: 'Saúde',    cor: '#EC4899', local: 'Clínica Derma' },
    { titulo: 'Aniversário da Bia',    data: maisDias(9),  hora: '20:00', categoria: 'Família',  cor: '#F97316' },
    { titulo: 'Sessão de fotos',       data: maisDias(12), hora: '09:00', categoria: 'Trabalho', cor: '#7C3AED' },
  ].map((c) => ({ ...c, grupo_id: grupoId, user_id: userId, lembrete_ativo: false }));
  const { error: ec } = await sb.from('compromissos').insert(comps);
  if (ec) log(`  ⚠️ compromissos: ${ec.message.slice(0, 70)}`); else log(`· ${comps.length} compromissos`);

  const humores = [];
  const escala = [4, 5, 4, 3, 5, 4, 5, 4, 4, 5, 3, 4, 5, 4];
  for (let d = 13; d >= 0; d--) {
    const dt = new Date(HOJE); dt.setDate(dt.getDate() - d);
    humores.push({
      grupo_id: grupoId, user_id: userId, data: iso(dt),
      humor: escala[13 - d], energia: escala[13 - d], sono_horas: 7 + ((d % 3) * 0.5),
    });
  }
  const { error: eu } = await sb.from('registros_humor').insert(humores);
  if (eu) log(`  ⚠️ registros_humor: ${eu.message.slice(0, 70)}`); else log(`· ${humores.length} registros de humor`);
}

// ═══════════════════════════════════════════════════════════════════════════
// main
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  if (EMAIL !== 'comercialsora@gmail.com') throw new Error('trava de segurança: e-mail inesperado');
  log(`\n═══ CONTA DE DEMONSTRAÇÃO — ${EMAIL} ═══\n`);

  const userId = await garantirUsuario();
  const grupoId = await garantirPerfil(userId);
  log(`· grupo ${grupoId}`);

  await configurarConta(userId);
  await limpar(grupoId);
  await garantirCategorias(grupoId);
  await criarCarteiras(grupoId, userId);
  await criarTransacoes(grupoId, userId);
  await criarFinanceiro(grupoId, userId);
  await criarGrow(grupoId, userId);

  // Conta padrão: sem ela o app pergunta "de qual conta saiu?" numa gravação.
  const { data: w } = await sb.from('wallets')
    .select('id').eq('grupo_id', grupoId).eq('nome', 'Nubank').maybeSingle();
  if (w) await sb.from('users').update({ wallet_padrao_id: w.id }).eq('id', userId);

  log(`\n✓ pronto — entrar em https://www.forsora.com/login`);
  log(`   e-mail: ${EMAIL}`);
  log(`   senha:  ${SENHA}\n`);
})().catch((e) => { console.error('\nFALHOU:', e.message); process.exit(1); });
