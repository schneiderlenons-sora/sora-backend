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

// =============================================================================
// PAGAMENTO DE FATURA VINDO DO OPEN FINANCE
//
// BUG QUE ISTO CORRIGE: o sync já importava o pagamento da fatura como
// transação (`Recebimento` + `transferencia`, categoria Fatura) — medido numa
// conta real: R$ 2.243,60 em 03/08 e R$ 565,68 em 09/08. Mas NADA disso chegava
// em `pagamentos_fatura`, que é a tabela que o `statusFatura` consulta pra
// calcular `restante = fatura − pago`. Resultado: `pago = 0` pra sempre, a
// fatura nunca ficava quitada e o painel continuava parado nela.
// =============================================================================

/**
 * Competência que um pagamento feito em `dataPg` quitou.
 *
 * É a fatura de vencimento MAIS PRÓXIMO da data do pagamento — a mesma ideia de
 * `vencimentoCoberto` em services/vencimentoDivida.js. Pagar dia 09 uma fatura
 * que vence dia 13 é "pagou a de agosto" (adiantado); pagar dia 20 é "pagou a
 * de agosto atrasado", não a de setembro. Escolher sempre a próxima a vencer
 * jogaria todo pagamento atrasado pra fatura errada.
 */
function competenciaDoPagamento(cartao, dataPg) {
  const { competenciaAtual, competenciaVizinha } = require('./cicloFatura');
  // Sem dia de vencimento o ciclo cai no mês-calendário (legado) e o "mais
  // próximo" passa a comparar com o ÚLTIMO DIA do mês — pagar 09/08 daria a
  // competência de julho. Melhor não gravar do que gravar na fatura errada.
  if (!cartao || !cartao.dia_vencimento) return null;
  const dia = String(dataPg).slice(0, 10);
  const proxima = competenciaAtual(cartao, dia);
  if (!proxima) return null;
  const anterior = competenciaVizinha(cartao, proxima, -1);

  const dist = (comp) => {
    const c = cicloPorCompetencia(cartao, comp);
    if (!c || !c.venc) return Infinity;
    return Math.abs(Date.parse(`${c.venc}T12:00:00Z`) - Date.parse(`${dia}T12:00:00Z`));
  };
  return dist(anterior) < dist(proxima) ? anterior : proxima;
}

/** Pagamentos registrados numa competência (valor + data), do mais novo. */
async function pagamentosDaFatura(cartaoId, competencia) {
  try {
    const { data, error } = await supabase.from('pagamentos_fatura')
      .select('valor, data').eq('cartao_id', cartaoId).eq('competencia', competencia)
      .order('data', { ascending: false });
    return error ? [] : (data || []);
  } catch { return []; }
}

/**
 * A fatura foi PAGA depois de fechar?
 *
 * É a regra que o usuário pediu, literal: só se pode dar a fatura por encerrada
 * (e passar pra seguinte) quando existe pagamento DEPOIS da data de fechamento
 * que cobre o valor dela. Pagamento feito ANTES do fechamento não conta: no
 * Mercado Pago é comum abater a fatura em curso aos poucos (medido nesta conta:
 * R$ 2.243,60 no dia 03, com a fatura fechando dia 08) — e ela continua aberta
 * até fechar e ser quitada.
 *
 * ⚠️ No cartão de Open Finance, o valor da fatura já vem LÍQUIDO de pagamentos
 * (o `simulated_bill_total_amount` desconta os abatimentos do ciclo). Por isso
 * comparamos só com o que entrou DEPOIS do fechamento — descontar tudo de novo
 * zeraria fatura que ainda está de pé.
 */
function quitadaDepoisDoFechamento(pagamentos, fatura, ciclo) {
  if (!(Number(fatura) > 0.01) || !ciclo?.fim) return false;
  const depois = (pagamentos || [])
    .filter((p) => String(p.data).slice(0, 10) > ciclo.fim)
    .reduce((s, p) => s + (Number(p.valor) || 0), 0);
  return cent(depois) >= cent(fatura) - 0.01;
}

/**
 * Registra em `pagamentos_fatura` os pagamentos que o Open Finance trouxe.
 *
 * Idempotente por `transacao_id` — o sync roda todo dia e não pode empilhar o
 * mesmo pagamento. Tolerante de ponta a ponta: nada aqui derruba o sync.
 *
 * @returns {Promise<number>} quantos pagamentos NOVOS foram registrados
 */
async function registrarPagamentosDoOF(grupoId, cartao) {
  try {
    if (!grupoId || !cartao?.id || !cartao?.nome) return 0;
    // ⚠️ `ehPagamentoFaturaCat` (valorFatura.js), NÃO o `ehPagamentoFatura` do
    // catálogo: aquele compara a string EXATA e devolve false pra '💳 Fatura'.
    const { ehPagamentoFaturaCat } = require('./valorFatura');

    // Só o que veio do banco (`of_tx_id`) e é reconhecidamente pagamento de
    // fatura. Lançamento manual continua entrando pelo fluxo do painel.
    const { data: pgs } = await supabase.from('transacoes')
      .select('id, valor, data, categoria, transferencia, of_tx_id')
      .eq('grupo_id', grupoId).ilike('carteira_nome', cartao.nome)
      .eq('tipo', 'Recebimento').not('of_tx_id', 'is', null)
      .order('data', { ascending: false }).limit(200);
    const candidatos = (pgs || []).filter(
      (t) => t.transferencia === true && ehPagamentoFaturaCat(t.categoria) && Number(t.valor) > 0);
    if (!candidatos.length) return 0;

    // Quais já foram registrados (chave: transacao_id).
    const { data: jaTem } = await supabase.from('pagamentos_fatura')
      .select('transacao_id').eq('cartao_id', cartao.id)
      .in('transacao_id', candidatos.map((t) => t.id));
    const registrados = new Set((jaTem || []).map((p) => p.transacao_id));

    const novos = [];
    for (const t of candidatos) {
      if (registrados.has(t.id)) continue;
      const competencia = competenciaDoPagamento(cartao, t.data);
      if (!competencia) continue;
      novos.push({
        grupo_id: grupoId, cartao_id: cartao.id, competencia,
        valor: cent(t.valor), data: String(t.data).slice(0, 10), transacao_id: t.id,
      });
    }
    if (!novos.length) return 0;

    const { error } = await supabase.from('pagamentos_fatura').insert(novos);
    if (error) return 0;                     // migration 096 pendente, p.ex.
    return novos.length;
  } catch { return 0; }
}

module.exports.competenciaDoPagamento = competenciaDoPagamento;
module.exports.registrarPagamentosDoOF = registrarPagamentosDoOF;
module.exports.pagamentosDaFatura = pagamentosDaFatura;
module.exports.quitadaDepoisDoFechamento = quitadaDepoisDoFechamento;
