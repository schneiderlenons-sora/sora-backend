// =============================================================================
// faturaVista — QUAL VALOR A TELA MOSTRA numa fatura, e se ela já foi paga.
//
// FONTE ÚNICA das duas rotas de fatura (`/fatura/status` e `/faturas`) e do
// feed da agenda. Antes cada uma decidia a sua e as telas divergiam no mesmo
// cartão.
//
// ── A ORDEM DE PRIORIDADE (do mais confiável pro menos) ─────────────────────
//
// 1. FATURA PUBLICADA PELO BANCO (of_faturas, migration 118) — a VERDADE.
//    `bill_total_amount` menos `payments[]`. É literalmente o número que o
//    cliente vê no app do banco, então não há o que reconstruir.
//    Isto entrou porque reconstruir falhava de três jeitos diferentes, todos
//    vistos em produção: transação faltando (app R$ 1.035,55 × banco
//    R$ 1.788,00), carteira duplicada contando a mesma compra duas vezes, e
//    parcela sem marcador "N/M" sumindo da fatura.
//
// 2. FATURA SIMULADA (`simulated_bill_total_amount`, chega em `wallets.saldo`
//    como `−fatura`) — pro ciclo que o emissor ainda NÃO publicou.
//    ⚠️ E SÓ NA COMPETÊNCIA CERTA. A doc da Polp define o campo como "soma dos
//    débitos SEM FATURA no ciclo atual (após o último `bill_closing_date`, até
//    +31 dias)" — ou seja, é o ciclo SEGUINTE ao da última fatura publicada,
//    que nem sempre é a competência atual. Quando o emissor atrasa (o Mercado
//    Pago nunca publica a fatura em aberto), o simulado é uma fatura que já
//    FECHOU; pendurá-lo na competência atual mostrava o valor de uma fatura em
//    cima dos lançamentos de outra (R$ 560,68 de agosto exibido como setembro).
//    ⚠️ O simulado já vem LÍQUIDO de pagamentos — descontar `pago` de novo
//    zeraria fatura que ainda está de pé.
//
// 3. SOMA DO CICLO + parcelas previstas (of_parcelas_previstas, migration 116)
//    — o fallback pra fatura que ninguém publicou nem simulou (tipicamente a
//    futura). Medido: 282,27 + 276,51 = 558,78, igual ao app do MP.
//
// 4. CARTÃO MANUAL → `fatura − pago`, como sempre foi.
//
// `quitada` é sinal de NAVEGAÇÃO (a tela pula pra fatura seguinte) e segue a
// regra literal: só encerra a fatura o pagamento feito DEPOIS do fechamento.
// =============================================================================
const { competenciaAtual, hojeSP } = require('./cicloFatura');
const { pagamentosDaFatura, quitadaDepoisDoFechamento } = require('./faturaRollover');
const { faturasDoCartao, competenciaDoSimulado } = require('./faturasBanco');

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * @param {object} cartao  wallet ({ id, saldo, of_conta_id, dia_fechamento, dia_vencimento })
 * @param {string} competencia  'YYYY-MM'
 * @param {object} st  saída de faturaRollover.statusFatura (fatura/pago/restante/ciclo)
 * @param {object} deps  injeção pra teste:
 *        { parcelasPrevistas(cartaoId, competencia) -> {total},
 *          faturasBanco(cartaoId) -> [ {competencia,total,pago,...} ] }
 */
async function valorExibido(cartao, competencia, st, deps = {}) {
  const ehOF = !!cartao.of_conta_id;
  const lerFaturas = deps.faturasBanco || faturasDoCartao;

  let fatura = st.fatura, pago = st.pago, restante = st.restante;
  let fonte = 'ciclo';                       // de onde saiu o número (diagnóstico)

  if (ehOF) {
    const faturas = await lerFaturas(cartao.id);
    const publicada = (faturas || []).find((f) => f && f.competencia === competencia);

    if (publicada && publicada.total != null) {
      // ── 1. O banco publicou esta fatura: usa o número dele, ponto.
      fatura   = cent(publicada.total);
      pago     = cent(publicada.pago || 0);
      restante = Math.max(0, cent(fatura - pago));
      fonte    = 'banco';
    } else if (
      // ── 2. Ciclo ainda não publicado: o simulado vale, mas SÓ na competência
      //      a que ele se refere (a seguinte à última publicada). Sem fatura
      //      publicada nenhuma não dá pra saber a qual ciclo ele pertence —
      //      aí cai no comportamento antigo (competência atual), que é o
      //      melhor palpite disponível.
      typeof cartao.saldo === 'number' && cartao.saldo < 0
      && competencia === (competenciaDoSimulado(cartao, faturas) || competenciaAtual(cartao))
    ) {
      fatura   = cent(-cartao.saldo);
      pago     = 0;                          // simulado já é líquido de pagamentos
      restante = fatura;
      fonte    = 'simulada';
    } else if (deps.parcelasPrevistas) {
      // ── 3. Nem publicada nem simulada (fatura futura): soma do ciclo mais as
      //      parcelas que só o banco conhece.
      const prev = await deps.parcelasPrevistas(cartao.id, competencia);
      fatura   = cent(st.fatura + (prev?.total || 0));
      restante = Math.max(0, cent(fatura - pago));
      fonte    = 'ciclo+previstas';
    }
  }

  const pagamentos = await pagamentosDaFatura(cartao.id, competencia);
  // Com o valor vindo do BANCO, `restante` já reflete os pagamentos que ele
  // conhece — quitada é simplesmente "não sobrou nada". Nos outros casos vale
  // a regra do pagamento DEPOIS do fechamento (o simulado é líquido, então
  // `restante` sozinho nunca zera).
  const quitada = fonte === 'banco'
    ? (fatura > 0.01 && restante <= 0.01)
    : fonte === 'simulada'
      ? quitadaDepoisDoFechamento(pagamentos, fatura, st.ciclo)
      : (fatura > 0.01 && restante <= 0.01 && st.ciclo.fim < hojeSP());

  return {
    fatura, pago, restante, quitada,
    fechada: st.ciclo.fim < hojeSP(),
    // `doBanco` = o número não saiu da nossa soma de transações. A tela usa
    // isso pra decidir se pode confiar no valor (e pra rotular a origem).
    doBanco: fonte === 'banco' || fonte === 'simulada',
    fonte,
  };
}

module.exports = { valorExibido, cent };
