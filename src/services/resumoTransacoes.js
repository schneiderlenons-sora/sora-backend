// =============================================================================
// resumoTransacoes — FONTE ÚNICA do resumo financeiro de um grupo num mês.
//
// Usado por GET /api/transacoes/:phone/resumo (relatórios/categorias) e pelo
// endpoint consolidado GET /api/dashboard/:phone. Centraliza a regra de "o que
// conta como gasto" pra os dois nunca divergirem (ex: pagamento de fatura =
// transferência/quitação de dívida, fica fora do consumo).
// =============================================================================
const supabase = require('../db/supabase');

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
  return r.transferencia === true || r.categoria === 'Fatura cartão' || r.categoria === 'Transferências';
}

// Resumo do mês: { receitas, gastos, saldo, por_categoria[], por_membro[] }.
// criadoPorId (opcional): filtra só as transações criadas por esse usuário.
async function calcularResumo({ grupoId, mes, criadoPorId } = {}) {
  let q = supabase.from('transacoes')
    .select('tipo, categoria, valor, criado_por, transferencia')
    .eq('grupo_id', grupoId)
    .gte('data', `${mes}-01`).lt('data', proximoMesPrimeiroDia(mes));
  if (criadoPorId) q = q.eq('criado_por', criadoPorId);
  const { data: rows } = await q;

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

module.exports = { calcularResumo, ehTransferencia, proximoMesPrimeiroDia };
