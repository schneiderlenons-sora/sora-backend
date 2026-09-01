// =============================================================================
// resumoTransacoes — FONTE ÚNICA do resumo financeiro de um grupo num mês.
//
// Usado por GET /api/transacoes/:phone/resumo (relatórios/categorias) e pelo
// endpoint consolidado GET /api/dashboard/:phone. Centraliza a regra de "o que
// conta como gasto" pra os dois nunca divergirem (ex: pagamento de fatura =
// transferência/quitação de dívida, fica fora do consumo).
// =============================================================================
const supabase = require('../db/supabase');
const { ehPagamentoFatura } = require('./categorizar');

// Primeiro dia do mês seguinte (YYYY-MM-01) — limite exclusivo seguro.
function proximoMesPrimeiroDia(mes) {
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// Transferência / quitação de dívida (não é consumo nem receita).
// `transferencia` é a flag canônica (migration 046); o match por categoria é
// rede de segurança (linhas sem a flag): pagamento de fatura e movimentações
// (Pix/TED do Open Finance caem em "Transferências").
function ehTransferencia(r) {
  // ⚠️ "Não considerar" (regra do usuário, migration 146) sai das somas nos
  // DOIS escopos — 'fluxo' e 'tudo'. A diferença entre eles é só a FATURA, que
  // é decidida em services/valorFatura.js. Aqui é receita × despesa, e nos dois
  // casos a linha não conta.
  if (r.ignorar_em) return true;
  return r.transferencia === true || ehPagamentoFatura(r.categoria) || r.categoria === 'Transferências';
}

// Resumo do mês: { receitas, gastos, saldo, por_categoria[], por_membro[] }.
// criadoPorId (opcional): filtra só as transações criadas por esse usuário.
async function calcularResumo({ grupoId, mes, criadoPorId } = {}) {
  let q = supabase.from('transacoes')
    // ⚠️ `ignorar_em` (146) precisa vir junto — `ehTransferencia` a lê. Pedir
    // uma coluna que não existe faria o SELECT INTEIRO falhar e o resumo do mês
    // voltar vazio pra todo mundo, então a leitura é tolerante logo abaixo.
    .select('tipo, categoria, valor, criado_por, transferencia, ignorar_em')
    .eq('grupo_id', grupoId)
    .gte('data', `${mes}-01`).lt('data', proximoMesPrimeiroDia(mes));
  if (criadoPorId) q = q.eq('criado_por', criadoPorId);
  // ⚠️ ARQUIVADAS FICAM DE FORA (migration 131). Este é o ponto ÚNICO do
  // resumo do painel E do dashboard, então filtrar aqui cobre os dois — e
  // garante que o total exibido bata com a soma das linhas da lista, que
  // também as esconde. Contar aqui e esconder lá seria o número mágico que
  // custou semanas de investigação na fatura do cartão.
  q = await require('./arquivadas').filtrar(q, {});
  let { data: rows, error: errIgnorar } = await q;

  // ⚠️ REDE DA MIGRATION 146. Sem a coluna `ignorar_em`, o Supabase reprova o
  // SELECT INTEIRO e `rows` volta vazio — o resumo do mês zeraria pra TODA a
  // base até a migration rodar. É o mesmo acidente que já derrubou o Grow
  // ("Usuário não encontrado"). Aqui refaz sem a coluna.
  if (errIgnorar && /ignorar_em/i.test(errIgnorar.message || '')) {
    let q2 = supabase.from('transacoes')
      .select('tipo, categoria, valor, criado_por, transferencia')
      .eq('grupo_id', grupoId)
      .gte('data', `${mes}-01`).lt('data', proximoMesPrimeiroDia(mes));
    if (criadoPorId) q2 = q2.eq('criado_por', criadoPorId);
    q2 = await require('./arquivadas').filtrar(q2, {});
    rows = (await q2).data;
  }

  let receitas = 0, gastos = 0;
  const porCategoria    = {}; // gastos por categoria
  const porCategoriaRec = {}; // receitas por categoria (mesma regra do total)
  const porMembro    = {}; // user_id -> { gastos, receitas }
  const bumpMembro = (id, campo, v) => {
    if (!id) return;
    if (!porMembro[id]) porMembro[id] = { gastos: 0, receitas: 0 };
    porMembro[id][campo] += v;
  };
  (rows || []).forEach(r => {
    if (ehTransferencia(r)) return;
    if (r.tipo === 'Gasto') {
      gastos += r.valor;
      porCategoria[r.categoria] = (porCategoria[r.categoria] || 0) + r.valor;
      bumpMembro(r.criado_por, 'gastos', r.valor);
    } else {
      receitas += r.valor;
      porCategoriaRec[r.categoria || 'Outros'] = (porCategoriaRec[r.categoria || 'Outros'] || 0) + r.valor;
      bumpMembro(r.criado_por, 'receitas', r.valor);
    }
  });

  // Resolve nomes dos membros
  const ids = Object.keys(porMembro);
  const nomes = {};
  if (ids.length) {
    const { data: usrs } = await supabase.from('users')
      .select('id, name, phone').in('id', ids);
    (usrs || []).forEach(u => { nomes[u.id] = { name: u.name, phone: u.phone }; });
  }

  return {
    receitas, gastos,
    saldo: receitas - gastos,
    por_categoria: Object.entries(porCategoria)
      .map(([categoria, total]) => ({ categoria, total }))
      .sort((a, b) => b.total - a.total),
    por_categoria_receitas: Object.entries(porCategoriaRec)
      .map(([categoria, total]) => ({ categoria, total }))
      .sort((a, b) => b.total - a.total),
    por_membro: Object.entries(porMembro)
      .map(([user_id, v]) => ({
        user_id,
        name: nomes[user_id]?.name || 'Desconhecido',
        phone: nomes[user_id]?.phone,
        gastos: v.gastos,
        receitas: v.receitas,
        saldo: v.receitas - v.gastos,
        total: v.gastos, // backward-compat: "Gastos por membro" usava `total` = gastos
      }))
      .sort((a, b) => b.gastos - a.gastos),
  };
}

/**
 * Resumo do ANO: 12 posições [{ mes: 1..12, receitas, gastos, saldo }].
 *
 * ⚠️ MORA AQUI, e não numa query própria da rota, POR DESIGN. Este arquivo é a
 * fonte única do "o que conta como gasto" — a mesma `ehTransferencia` e o mesmo
 * corte de arquivadas do resumo mensal. Uma segunda regra em outro lugar faria
 * o gráfico anual divergir do card do mês, que é a classe de bug mais cara
 * desta base.
 *
 * UMA query pro ano inteiro (não 12): a linha traz `data`, e o agrupamento é
 * feito em memória.
 */
async function calcularResumoAnual({ grupoId, ano, criadoPorId } = {}) {
  const meses = Array.from({ length: 12 }, (_, i) => ({
    mes: i + 1, receitas: 0, gastos: 0, saldo: 0,
  }));

  let q = supabase.from('transacoes')
    .select('tipo, categoria, valor, data, criado_por, transferencia')
    .eq('grupo_id', grupoId)
    .gte('data', `${ano}-01-01`).lt('data', `${Number(ano) + 1}-01-01`);
  if (criadoPorId) q = q.eq('criado_por', criadoPorId);
  q = await require('./arquivadas').filtrar(q, {});
  const { data: rows } = await q;

  (rows || []).forEach((r) => {
    if (ehTransferencia(r)) return;
    // A data vem 'YYYY-MM-DD' do Postgres (tipo date) — fatiar é seguro e não
    // passa por `new Date()`, que interpretaria como UTC e jogaria o dia 1º de
    // cada mês pro mês anterior.
    const m = Number(String(r.data).slice(5, 7));
    if (!(m >= 1 && m <= 12)) return;
    const alvo = meses[m - 1];
    if (r.tipo === 'Gasto') alvo.gastos += r.valor;
    else alvo.receitas += r.valor;
  });

  for (const m of meses) m.saldo = m.receitas - m.gastos;
  return {
    ano: Number(ano),
    meses,
    receitas: meses.reduce((s, m) => s + m.receitas, 0),
    gastos:   meses.reduce((s, m) => s + m.gastos, 0),
  };
}

module.exports = { calcularResumo, calcularResumoAnual, ehTransferencia, proximoMesPrimeiroDia };
