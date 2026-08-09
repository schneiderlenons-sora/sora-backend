// =============================================================================
// faturaRollover — pagamento parcial da fatura + rollover do saldo (SEM juros).
//
// Modelo (cartão MANUAL; Open Finance fica de fora — traz a fatura do banco):
//   • fatura(comp)   = soma ASSINADA do cartão no CICLO daquela competência
//                      (compra soma, estorno/crédito ABATE, pagamento é
//                       neutro — ver services/valorFatura.js)
//   • pago(comp)     = soma de pagamentos_fatura do cartão naquela competência
//   • restante(comp) = max(0, fatura − pago)
//
// ⚠️ O período é o CICLO REAL de fechamento (services/cicloFatura.js), não o
// mês-calendário: uma compra em 30/07 e outra em 01/08 caem na MESMA fatura
// quando o cartão fecha dia 5. `competencia` = 'YYYY-MM' do VENCIMENTO.
// Cartão sem dia_fechamento cai no mês-calendário (comportamento legado).
//
// Rollover: no vencimento, se restante > 0, abre fatura_rollover 'aguardando'
// (24h pra confirmar no WhatsApp). Confirmou OU passou 24h → materializa: cria
// um Gasto "Fatura anterior" no cartão no INÍCIO do ciclo seguinte, com o valor
// que sobrou. É marcado `transferencia:true` → entra na SOMA da fatura (que
// filtra por tipo 'Gasto') mas fica FORA dos relatórios de gasto (a compra
// original já contou no mês dela). SEM juros (decisão de produto).
// =============================================================================
const supabase = require('../db/supabase');
const { cicloPorCompetencia, competenciaVizinha } = require('./cicloFatura');
const { somarFatura } = require('./valorFatura');

const TZ = 'America/Sao_Paulo';

function ymHoje() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ }).slice(0, 7);
}
function mesSeguinte(ym) {
  const [y, m] = ym.split('-').map(Number);   // m é 1-based; new Date(y, m, 1) = mês seguinte
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Soma a fatura do cartão dentro de um intervalo [ini, fimExcl) — o ciclo.
//
// A soma é ASSINADA (services/valorFatura.js): compra soma, estorno/cashback
// ABATE, pagamento de fatura é neutro (já entra por `pagamentos_fatura`).
// Antes filtrava `tipo='Gasto'` no SQL e todo crédito era descartado.
//
// NÃO filtra `transferencia` no lado do Gasto: de propósito, pra o "Fatura
// anterior" (rollover) entrar na soma da fatura seguinte.
async function somaFaturaCiclo(grupoId, cartaoNome, ciclo) {
  const { data } = await supabase.from('transacoes')
    .select('valor, tipo, categoria, transferencia')
    .eq('grupo_id', grupoId).ilike('carteira_nome', cartaoNome)
    .gte('data', ciclo.ini).lt('data', ciclo.fimExcl);
  return somarFatura(data || []);
}

async function pagoDaFatura(cartaoId, ym) {
  const { data, error } = await supabase.from('pagamentos_fatura')
    .select('valor').eq('cartao_id', cartaoId).eq('competencia', ym);
  if (error) return 0; // tolerante à migration 096
  return (data || []).reduce((s, p) => s + (Number(p.valor) || 0), 0);
}

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Status da fatura de uma competência. `cartao` precisa de { id, nome,
// dia_fechamento, dia_vencimento } — o ciclo sai daí. Devolve o `ciclo` junto
// pra quem chama poder exibir o período sem recalcular.
async function statusFatura(grupoId, cartao, ym) {
  const ciclo = cicloPorCompetencia(cartao, ym);
  const fatura = cent(await somaFaturaCiclo(grupoId, cartao.nome, ciclo));
  const pago = cent(await pagoDaFatura(cartao.id, ym));
  const restante = Math.max(0, cent(fatura - pago));
  return { fatura, pago, restante, ciclo };
}

// Cria o lançamento "Fatura anterior" na fatura SEGUINTE e marca o rollover
// rolado. A data é o INÍCIO do ciclo seguinte (antes era o dia 1 do mês, que
// com ciclo real podia cair na fatura errada).
async function materializarRollover(row, cartaoNome, cartao) {
  const compAlvo = cartao?.dia_fechamento
    ? competenciaVizinha(cartao, row.competencia, 1)
    : mesSeguinte(row.competencia);
  const cicloAlvo = cicloPorCompetencia(
    cartao || { dia_vencimento: null }, compAlvo,
  );
  const idCurto = Math.random().toString(36).substring(2, 8).toUpperCase();
  const base = {
    id_curto:      idCurto,
    grupo_id:      row.grupo_id,
    criado_por:    row.user_id || null,
    tipo:          'Gasto',
    categoria:     'Fatura anterior',
    valor:         Number(row.valor),
    observacao:    `Saldo não pago da fatura ${row.competencia}`,
    carteira_nome: cartaoNome,
    pago:          true,
    data:          `${cicloAlvo.ini}T12:00:00.000Z`,
  };
  // transferencia:true → soma na fatura (filtro por tipo 'Gasto') mas fora dos
  // relatórios de gasto. Tolerante se a coluna 046 não existir.
  let { data: tx, error } = await supabase.from('transacoes')
    .insert({ ...base, transferencia: true }).select('id').single();
  if (error && /transferencia/i.test(error.message || '')) {
    ({ data: tx, error } = await supabase.from('transacoes').insert(base).select('id').single());
  }
  if (error) throw error;

  await supabase.from('fatura_rollover').update({
    status: 'rolado', rolado_em: new Date().toISOString(),
    transacao_rollover_id: tx?.id || null,
  }).eq('id', row.id);
  return tx;
}

module.exports = { TZ, ymHoje, mesSeguinte, somaFaturaCiclo, pagoDaFatura, statusFatura, materializarRollover, cent };
