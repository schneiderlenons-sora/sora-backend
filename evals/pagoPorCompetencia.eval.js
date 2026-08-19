// =============================================================================
// EVAL — a quem pertence cada pagamento que o banco pendura na fatura
//
// ⚠️ O `payments[]` de uma fatura NÃO é o conjunto de pagamentos daquela
// fatura. É o que passou pela conta enquanto ela era a fatura publicada — e
// isso inclui pagamento de fatura ANTERIOR e de POSTERIOR. Nós somávamos tudo
// (`pagoDaBill`) e fazíamos `restante = total − pago`.
//
// OS DOIS DESVIOS, com dados reais (of_faturas.pagamentos, migration 128):
//
//   Mercado Pago · fatura 2026-07 · fecha 12/07 · vence 17/07 · total R$ 3,13
//     R$     3,13 @ 16/07   ← esta sim é dela
//     R$ 2.243,60 @ 03/08   ← é de agosto
//     R$   565,68 @ 09/08   ← é de agosto
//     `pago` somava os três: R$ 2.812,41 numa fatura de R$ 3,13.
//
//   Cartão EQI BLACK · fatura 2026-08 · fecha 15/08 · total R$ 3.517,11
//     R$ 4.359,17 @ 20/07   ← 26 dias ANTES de a fatura existir
//     (é a fatura de julho, que venceu 19/07 e custou R$ 4.364,17)
//
// A atribuição usa `competenciaDoPagamento`: a fatura de vencimento MAIS
// PRÓXIMO da data do pagamento — a mesma regra que `registrarPagamentosDoOF`
// já aplica do outro lado.
// =============================================================================
const { pagoPorCompetencia, pagamentosDaBill } = require('../src/services/faturasBanco');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// ── 1. O CASO DO MERCADO PAGO (pagamento POSTERIOR pendurado) ────────────
console.log('── 1. pagamento de agosto pendurado na fatura de julho ──');
{
  const CARTAO = { dia_fechamento: 12, dia_vencimento: 17 };
  const faturas = [
    { competencia: '2026-07', total: 3.13, pago: 2812.41, pagamentos: [
      { valor: 3.13, data: '2026-07-16' },
      { valor: 2243.60, data: '2026-08-03' },
      { valor: 565.68, data: '2026-08-09' },
    ] },
  ];
  eq(pagoPorCompetencia(CARTAO, faturas, '2026-07'), 3.13,
    'julho fica com o pagamento de 16/07 — e só ele');
  eq(pagoPorCompetencia(CARTAO, faturas, '2026-08'), 2809.28,
    'os dois de agosto vão pra agosto (2.243,60 + 565,68)');

  // O efeito na tela: a fatura de R$ 3,13 estava "paga" por R$ 2.812,41.
  const restanteAntes = Math.max(0, 3.13 - 2812.41);
  const restanteDepois = Math.max(0, 3.13 - 3.13);
  eq(restanteAntes, 0, 'antes: zerada por excesso');
  eq(restanteDepois, 0, 'depois: zerada pelo valor certo');
}
console.log('  ok');

// ── 2. O CASO DO EQI BLACK (pagamento ANTERIOR pendurado) ────────────────
console.log('── 2. pagamento de julho pendurado na fatura de agosto ──');
{
  const CARTAO = { dia_fechamento: 15, dia_vencimento: 19 };
  const faturas = [
    { competencia: '2026-07', total: 4364.17, pago: 5570.08, pagamentos: [
      { valor: 5570.08, data: '2026-06-17' },
    ] },
    { competencia: '2026-08', total: 3517.11, pago: 4359.17, pagamentos: [
      { valor: 4359.17, data: '2026-07-20' },
    ] },
  ];
  // 20/07 está a 1 dia do vencimento de julho (19/07) e a 30 do de agosto.
  eq(pagoPorCompetencia(CARTAO, faturas, '2026-07'), 4359.17,
    'o pagamento de 20/07 quita a fatura de julho, atrasado em 1 dia');
  eq(pagoPorCompetencia(CARTAO, faturas, '2026-08'), 0,
    'agosto não recebe nada — e a fatura fica em aberto, como deve');

  // ⚠️ É AQUI que a tela mudava de verdade: antes, agosto aparecia QUITADA
  // (3.517,11 − 4.359,17 < 0) sem ninguém ter pago agosto.
  eq(Math.max(0, 3517.11 - 4359.17), 0, 'antes: agosto aparecia quitada');
  eq(Math.max(0, Math.round((3517.11 - 0) * 100) / 100), 3517.11, 'depois: agosto em aberto');
}
console.log('  ok');

// ── 3. Quando o banco está CERTO, nada muda ──────────────────────────────
//
// Na maioria dos cartões medidos o `payments[]` já é da própria fatura. A
// atribuição por data tem de devolver exatamente o mesmo número.
console.log('── 3. banco correto → resultado idêntico ──');
{
  const CARTAO = { dia_fechamento: 4, dia_vencimento: 11 };
  const faturas = [
    { competencia: '2026-08', total: 1000, pago: 1000, pagamentos: [{ valor: 1000, data: '2026-08-10' }] },
  ];
  eq(pagoPorCompetencia(CARTAO, faturas, '2026-08'), 1000, 'pagamento na véspera do vencimento fica onde estava');
}
console.log('  ok');

// ── 4. SEM AS DATAS, NÃO OPINA ───────────────────────────────────────────
//
// A garantia de não-regressão: enquanto a migration 128 não rodou (ou o cartão
// ainda não sincronizou), devolve null e quem chama mantém o `pago` do banco.
console.log('── 4. sem as datas, comportamento antigo ──');
{
  const CARTAO = { dia_fechamento: 4, dia_vencimento: 11 };
  eq(pagoPorCompetencia(CARTAO, [{ competencia: '2026-08', total: 100, pago: 100 }], '2026-08'), null,
    'fatura sem o campo `pagamentos` → null');
  eq(pagoPorCompetencia(CARTAO, [{ competencia: '2026-08', pagamentos: [] }], '2026-08'), null,
    'lista vazia também é "não sei"');
  eq(pagoPorCompetencia(CARTAO, [], '2026-08'), null, 'sem faturas → null');
  eq(pagoPorCompetencia(CARTAO, null, '2026-08'), null, 'null não quebra');
  // Sem dia de vencimento não há ciclo — atribuir seria chutar.
  eq(pagoPorCompetencia({ dia_fechamento: 4 }, [{ pagamentos: [{ valor: 10, data: '2026-08-10' }] }], '2026-08'),
    null, 'cartão sem dia_vencimento → null');
}
console.log('  ok');

// ── 5. O MESMO pagamento pendurado em DUAS faturas conta UMA vez ─────────
//
// O emissor repete o pagamento em mais de uma fatura publicada. Sem dedup ele
// seria somado uma vez por fatura, e a competência apareceria paga em dobro.
console.log('── 5. pagamento repetido em duas faturas ──');
{
  const CARTAO = { dia_fechamento: 4, dia_vencimento: 11 };
  const pg = { valor: 500, data: '2026-08-10' };
  const faturas = [
    { competencia: '2026-07', pagamentos: [pg] },
    { competencia: '2026-08', pagamentos: [pg] },
  ];
  eq(pagoPorCompetencia(CARTAO, faturas, '2026-08'), 500, 'conta uma vez, não duas');
}
console.log('  ok');

// ── 6. `pagamentosDaBill` — o que é lido do payload cru ──────────────────
console.log('── 6. leitura do payload do emissor ──');
{
  const linhas = pagamentosDaBill({ payments: [
    { amount: '4359.17', paymentDate: '2026-07-20', valueType: 'VALOR_PAGAMENTO_FATURA_REALIZADO', paymentMode: 'DEBITO_CONTA_CORRENTE' },
    { amount: '0', paymentDate: '2026-07-21' },
  ] });
  eq(linhas.length, 1, 'pagamento de valor zero não entra');
  eq(linhas[0].valor, 4359.17, 'valor lido');
  eq(linhas[0].data, '2026-07-20', 'data lida');
  eq(linhas[0].modo, 'DEBITO_CONTA_CORRENTE', 'modo preservado pra diagnóstico');
  eq(pagamentosDaBill({}), null, 'fatura sem payments → null (não [])');
  eq(pagamentosDaBill(null), null, 'null não quebra');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.log(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('✓ pagamento por competência: todos os casos passaram');
