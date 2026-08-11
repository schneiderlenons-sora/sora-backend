// =============================================================================
// faturaVista — QUAL VALOR A TELA MOSTRA numa fatura, e se ela já foi paga.
//
// FONTE ÚNICA das duas rotas de fatura (`/fatura/status` e `/faturas`). Antes
// cada uma decidia o seu, e as duas telas do painel divergiam no mesmo cartão.
//
// AS TRÊS REGRAS, NESTA ORDEM:
//
// 1. CARTÃO DE OPEN FINANCE NA FATURA ATUAL → o valor é do BANCO.
//    `saldo = −fatura`, alimentado pelo `simulated_bill_total_amount` da Polp.
//    ⚠️ Ele já chega LÍQUIDO dos pagamentos do ciclo — `pago` NÃO pode ser
//    descontado de novo, senão zera fatura que ainda está de pé.
//    Medido na conta do relato: a fatura de agosto era R$ 2.804,28, levou
//    R$ 2.243,60 de abatimento no dia 03, e o banco passou a publicar
//    R$ 560,68. Nossa soma das transações do ciclo dava R$ 3.190,81 — foi esse
//    número errado que apareceu na tela do cliente.
//
// 2. FATURA FUTURA → soma do ciclo + as parcelas que só o banco conhece
//    (of_parcelas_previstas, migration 116). O emissor não publica fatura que
//    ainda não fechou, então não há valor de banco pra usar aqui.
//    Medido: 282,27 + 276,51 = 558,78 — exatamente o que o app do MP mostra.
//
// 3. CARTÃO MANUAL → fatura − pago, como sempre foi.
//
// `quitada` é sinal de NAVEGAÇÃO (a tela pula pra fatura seguinte) e segue a
// regra literal: só encerra a fatura o pagamento feito DEPOIS do fechamento.
// =============================================================================
const { competenciaAtual, hojeSP } = require('./cicloFatura');
const { pagamentosDaFatura, quitadaDepoisDoFechamento } = require('./faturaRollover');

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * @param {object} cartao  wallet ({ id, saldo, of_conta_id, dia_fechamento, dia_vencimento })
 * @param {string} competencia  'YYYY-MM'
 * @param {object} st  saída de faturaRollover.statusFatura (fatura/pago/restante/ciclo)
 * @param {object} deps  { parcelasPrevistas(cartaoId, competencia) -> {total} }
 */
async function valorExibido(cartao, competencia, st, deps = {}) {
  const ehOF = !!cartao.of_conta_id;
  const ehAtual = competencia === competenciaAtual(cartao);
  const doBanco = ehOF && ehAtual && typeof cartao.saldo === 'number' && cartao.saldo < 0;

  let fatura = st.fatura, pago = st.pago, restante = st.restante;
  if (doBanco) {
    fatura = cent(-cartao.saldo);
    pago = 0;                       // o valor do banco JÁ é líquido de pagamentos
    restante = fatura;
  } else if (ehOF && deps.parcelasPrevistas) {
    const prev = await deps.parcelasPrevistas(cartao.id, competencia);
    fatura = cent(st.fatura + (prev?.total || 0));
    restante = Math.max(0, cent(fatura - pago));
  }

  const pagamentos = await pagamentosDaFatura(cartao.id, competencia);
  const quitada = doBanco
    ? quitadaDepoisDoFechamento(pagamentos, fatura, st.ciclo)
    : (fatura > 0.01 && restante <= 0.01 && st.ciclo.fim < hojeSP());

  return { fatura, pago, restante, quitada, fechada: st.ciclo.fim < hojeSP(), doBanco };
}

module.exports = { valorExibido, cent };
