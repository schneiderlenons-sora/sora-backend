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
// rede de segurança pra linhas antigas que não tenham a flag.
function ehTransferencia(r) {
  return r.transferencia === true || r.categoria === 'Fatura cartão';
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
  const porCategoria = {};
  const porMembro    = {};
  (rows || []).forEach(r => {
    if (ehTransferencia(r)) return;
    if (r.tipo === 'Gasto') {
      gastos += r.valor;
      porCategoria[r.categoria] = (porCategoria[r.categoria] || 0) + r.valor;
      if (r.criado_por) porMembro[r.criado_por] = (porMembro[r.criado_por] || 0) + r.valor;
    } else {
      receitas += r.valor;
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
    por_membro: Object.entries(porMembro)
      .map(([user_id, total]) => ({ user_id, total, name: nomes[user_id]?.name || 'Desconhecido', phone: nomes[user_id]?.phone }))
      .sort((a, b) => b.total - a.total),
  };
}

module.exports = { calcularResumo, ehTransferencia, proximoMesPrimeiroDia };
