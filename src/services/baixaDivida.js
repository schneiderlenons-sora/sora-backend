// =============================================================================
// baixaDivida — o débito do extrato que PAGOU a parcela de uma dívida.
//
// RELATO (Robert, out/2026): "parcelas de empréstimo aparecendo como não
// pagas". O extrato do Banco do Brasil trouxe os débitos do dia 20 — R$ 727,12
// e R$ 79,78 dos dois empréstimos do BB, R$ 1.000,08 da Cooperforte —, mas nada
// ligava esses débitos às dívidas. A dívida só sabe que foi paga por
// `divida_pagamentos`, e ninguém tinha registrado nada lá.
//
// Esta régua SUGERE o par; quem decide é a pessoa (e o servidor reconfere).
// Confirmar registra a parcela como paga SEM debitar a conta de novo — o
// dinheiro já saiu, é o próprio débito do extrato.
//
// ── POR QUE SUGESTÃO, E NUNCA AUTOMÁTICO ────────────────────────────────────
// O banco cobra um pouco MAIS que a parcela cadastrada (juros do dia, IOF,
// seguro): 727,12 contra 720,34 (+0,94%) e 79,78 contra 79,11 (+0,85%). Sem
// valor exato não há prova — mesma lição do `casarPrevisao` (a "Luz" que
// assumiu uma compra de farmácia quando a conciliação era larga e automática).
//
// ── A RÉGUA ─────────────────────────────────────────────────────────────────
//   · o débito tem CARA de empréstimo: categoria (Empréstimos e
//     Financiamentos, Dívidas, Consórcio) ou descrição (CDC, empréstimo,
//     financiamento, consórcio, crédito pessoal);
//   · saiu de CONTA, não de cartão de crédito;
//   · está perto do vencimento ABERTO mais recente da dívida: de 5 dias antes
//     a 10 dias depois (o BB debitou 21/08 e 22/09 parcelas do dia 20 —
//     fim de semana empurra);
//   · o valor fica a até 5% da parcela (nunca menos de R$ 1);
//   · PAR SEM DISPUTA: um débito serve uma dívida só, e se duas dívidas
//     disputam o mesmo débito quase empatadas, nenhuma é sugerida.
//
// ⚠️ O DÉBITO ÚNICO QUE COBRE VÁRIAS DÍVIDAS FICA DE FORA DE PROPÓSITO. O
// R$ 1.000,08 da Cooperforte paga três empréstimos (474,21 + 435,04 + 101,51 =
// 1.010,76) e não fecha com a soma. Adivinhar a partilha seria inventar número;
// esse caso se liga à mão, no "Pagar parcela" (escolhendo o débito).
//
// Eval: npm run eval:baixa-divida
// =============================================================================
const { ocorrencia, vencimentoCoberto, diffDias } = require('./vencimentoDivida');
const { diaSP } = require('./consultaParcela');

const TOLERANCIA_PCT = 0.05;
const TOLERANCIA_MIN = 1;
const DIAS_ANTES = 5;
const DIAS_DEPOIS = 10;
// Duas dívidas "empatam" pelo mesmo débito quando a diferença relativa delas
// fica a menos de meio ponto percentual uma da outra.
const EMPATE = 0.005;

const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;

const RE_CATEGORIA = /emprestimo|financiamento|divida|consorcio/;
const RE_DESCRICAO = /\bcdc\b|emprestimo|financiamento|consorcio|credito pessoal/;

/** O lançamento tem cara de parcela de empréstimo? */
function ehDebitoDeEmprestimo(t) {
  if (!t || t.tipo !== 'Gasto' || t.transferencia === true) return false;
  if (RE_CATEGORIA.test(semAcento(t.categoria))) return true;
  return RE_DESCRICAO.test(semAcento(t.observacao || t.descricao));
}

/**
 * O vencimento ABERTO mais recente da dívida — o que um débito de hoje poderia
 * estar pagando. `null` quando não há (quitada, ainda não começou, ou o último
 * pagamento já cobriu).
 *
 * Só o MAIS RECENTE: se setembro e outubro estão em aberto, sugerir os dois
 * encheria a tela, e pagar outubro já cobre setembro na regra do card
 * (`vencimentoCoberto(pago) >= venc`).
 */
function vencimentoAberto(divida, hoje) {
  const dia = Number(divida && divida.dia_vencimento);
  if (!dia || dia < 1 || dia > 31) return null;
  if (divida.status === 'quitada') return null;
  const total = Number(divida.parcelas_total) || 0;
  if (total > 0 && (Number(divida.parcelas_pagas) || 0) >= total) return null;

  const [Y, M] = String(hoje).slice(0, 10).split('-').map(Number);
  // A ocorrência deste mês, se já está a até DIAS_ANTES de hoje; senão a do mês passado.
  let venc = ocorrencia(Y, M - 1, dia);
  if (diffDias(hoje, venc) > DIAS_ANTES) venc = ocorrencia(Y, M - 2, dia);

  // A 1ª parcela nunca vence no mês do contrato.
  if (divida.data_inicio && venc <= String(divida.data_inicio).slice(0, 10)) return null;
  // O emissor diz que a próxima é DEPOIS desta (dívida do Open Finance).
  if (divida.proximo_vencimento && String(divida.proximo_vencimento).slice(0, 10) > venc) return null;
  // O último pagamento registrado já cobriu esta parcela.
  const pago = divida.ultimo_pagamento ? String(divida.ultimo_pagamento).slice(0, 10) : null;
  if (pago && vencimentoCoberto(pago, dia) >= venc) return null;
  return venc;
}

/**
 * @param {object} p
 * @param {object[]} p.dividas      linhas de `dividas` + `ultimo_pagamento`
 * @param {object[]} p.transacoes   Gastos recentes do grupo
 * @param {Set<string>} [p.carteirasCredito]  nomes (minúsculos) dos cartões — ficam de fora
 * @param {Set<string>} [p.ligadas]  ids de transação já ligados a um pagamento de dívida
 * @param {string} p.hoje 'YYYY-MM-DD' em São Paulo
 * @returns {object[]} sugestões, uma por dívida no máximo
 */
function sugestoesBaixa({ dividas, transacoes, carteirasCredito, ligadas, hoje }) {
  const cartoes = carteirasCredito || new Set();
  const usadas = ligadas || new Set();

  const debitos = (transacoes || []).filter((t) => t && t.id
    && ehDebitoDeEmprestimo(t)
    && t.pago !== false
    && !usadas.has(t.id)
    && !cartoes.has(String(t.carteira_nome || '').toLowerCase())
    && Number(t.valor) > 0);

  const candidatos = [];
  for (const d of dividas || []) {
    const parcela = Number(d.valor_parcela) || 0;
    if (parcela <= 0) continue;
    const venc = vencimentoAberto(d, hoje);
    if (!venc) continue;
    const tolerancia = Math.max(parcela * TOLERANCIA_PCT, TOLERANCIA_MIN);
    for (const t of debitos) {
      const dia = diaSP(t.data);
      const dist = diffDias(venc, dia);
      if (dist < -DIAS_ANTES || dist > DIAS_DEPOIS) continue;
      const diferenca = cent(Number(t.valor) - parcela);
      if (Math.abs(diferenca) > tolerancia + 0.005) continue;
      candidatos.push({ d, t, venc, dia, diferenca, score: Math.abs(diferenca) / parcela, dist: Math.abs(dist) });
    }
  }

  // Par sem disputa: o débito disputado por duas dívidas quase empatadas não é
  // sugerido a nenhuma — escolher entre elas seria chute.
  const porTx = new Map();
  for (const c of candidatos) {
    if (!porTx.has(c.t.id)) porTx.set(c.t.id, []);
    porTx.get(c.t.id).push(c);
  }
  const disputadas = new Set();
  for (const [id, cs] of porTx) {
    const ord = cs.map((c) => c.score).sort((a, b) => a - b);
    if (ord.length > 1 && ord[1] - ord[0] < EMPATE) disputadas.add(id);
  }

  // Um para um, do par mais parecido pro menos.
  candidatos.sort((a, b) => a.score - b.score || a.dist - b.dist || String(a.t.id).localeCompare(String(b.t.id)));
  const dividaUsada = new Set(), txUsada = new Set(), out = [];
  for (const c of candidatos) {
    if (disputadas.has(c.t.id) || dividaUsada.has(c.d.id) || txUsada.has(c.t.id)) continue;
    dividaUsada.add(c.d.id); txUsada.add(c.t.id);
    out.push({
      divida_id: c.d.id,
      titulo: c.d.titulo,
      valor_parcela: cent(c.d.valor_parcela),
      vencimento: c.venc,
      transacao: {
        id: c.t.id, data: c.dia, valor: cent(c.t.valor),
        descricao: c.t.observacao || c.t.descricao || null, conta: c.t.carteira_nome || null,
      },
      diferenca: c.diferenca,
    });
  }
  return out;
}

module.exports = {
  sugestoesBaixa, vencimentoAberto, ehDebitoDeEmprestimo,
  TOLERANCIA_PCT, DIAS_ANTES, DIAS_DEPOIS,
};
