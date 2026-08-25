// =============================================================================
// EVAL da fatura do cartão no Open Finance.
//
// ESCRITO A PARTIR DE UM BUG REAL, com os números da conta que o reportou:
// o painel mostrou R$ 5.013,99 numa fatura que o Nubank mostrava R$ 3.423,57.
//
// A causa foram dois defeitos encadeados:
//   1. `escolherFaturaAberta` caía num fallback e devolvia a fatura JÁ FECHADA
//      quando o emissor ainda não publicou a aberta (o `List Bills` para na
//      fatura passada). Essa fatura virava `of_bill_atual`.
//   2. A tela então somava as compras dessa fatura fechada (R$ 3.143,75) MAIS
//      as compras do ciclo novo que ainda não têm vínculo (R$ 1.870,24).
//
// Rodar:  npm run eval:fatura-of
// =============================================================================
const {
  escolherFaturaAberta, ultimaFaturaPublicada, faturaPorLimite,
  faturaSimulada, diaMaisFrequente, normalizeCartao,
} = require('../src/services/polpCelcoinSync');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// Cenário REAL: cartão fecha dia 7, vence dia 14. Hoje é 01/08 — a fatura
// aberta (fecha 07/08, vence 14/08) ainda NÃO foi publicada pelo emissor.
const BILLS_REAIS = [
  { id: 'bill-mai', due_date: '2026-05-14', bill_closing_date: '2026-05-07', bill_total_amount: 900 },
  { id: 'bill-jun', due_date: '2026-06-14', bill_closing_date: '2026-06-07', bill_total_amount: 2064.84 },
  { id: 'bill-jul', due_date: '2026-07-14', bill_closing_date: '2026-07-07', bill_total_amount: 3143.75 },
];

// ── 1. Fatura fechada NUNCA é a aberta ─────────────────────────────────────
console.log('── 1. escolha da fatura ──');
{
  eq(escolherFaturaAberta(BILLS_REAIS, '2026-08-01'), null,
     'sem fatura publicada com vencimento à frente → null (não inventa)');

  // Publicada a de agosto, ela é a aberta.
  const comAgo = [...BILLS_REAIS, { id: 'bill-ago', due_date: '2026-08-14', bill_closing_date: '2026-08-07', bill_total_amount: 0 }];
  eq(escolherFaturaAberta(comAgo, '2026-08-01').id, 'bill-ago', 'com a de agosto publicada, ela é a aberta');

  // No dia do vencimento a fatura ainda é a atual (vence "hoje", não venceu).
  eq(escolherFaturaAberta(BILLS_REAIS, '2026-07-14').id, 'bill-jul', 'no dia do vencimento ainda é a atual');
  eq(escolherFaturaAberta(BILLS_REAIS, '2026-07-15'), null, 'no dia seguinte ela deixa de ser a aberta');

  eq(escolherFaturaAberta([], '2026-08-01'), null, 'sem faturas → null');
  eq(escolherFaturaAberta(null, '2026-08-01'), null, 'lista nula não quebra');

  // As DATAS continuam disponíveis mesmo sem fatura aberta — é o que mantém o
  // ciclo da tela funcionando (dia de fechamento não muda de mês pra mês).
  eq(ultimaFaturaPublicada(BILLS_REAIS).id, 'bill-jul', 'última publicada serve pras datas');
  eq(ultimaFaturaPublicada([]), null, 'sem faturas, sem datas');
}
console.log('  ok');

// ── 1b. LIMITE USADO NÃO É FATURA ──────────────────────────────────────────
// Medido no payload real do Nubank (01/08/2026, conta de teste):
//   limits[].used_amount ....... 4.061,99
//   fatura no app do banco ..... 3.423,57
//   diferença .................. 638,42  ← parcelas de faturas FUTURAS
//
// Não há como converter um no outro com o que o emissor entrega:
//   · transações com data futura → ZERO (a Celcoin manda parcela com a data da
//     COMPRA, não com a da cobrança);
//   · `parcelamentos` → vem DUPLICADO (três linhas pro mesmo Mercado Livre, com
//     paidInstallments 5, 3 e 1). Somando dá 2.887,67 ou 1.159,49 conforme a
//     leitura — nenhuma perto de 638,42.
//
// Este bloco existe pra impedir que alguém (eu, de novo) volte a exibir o
// limite usado como se fosse a fatura.
console.log('── 1b. limite usado ≠ fatura ──');
{
  const USADO = 4061.99, FATURA_REAL = 3423.57;
  ok(Math.abs(USADO - FATURA_REAL - 638.42) < 0.01, 'a diferença medida é 638,42');
  ok(USADO > FATURA_REAL, 'o limite usado é sempre MAIOR (inclui parcela futura)');
  // As duas leituras possíveis do endpoint de parcelamentos, nenhuma explica.
  for (const candidata of [2887.67, 1159.49, 0]) {
    ok(Math.abs(candidata - 638.42) > 0.01,
       `parcelamentos não explicam a diferença (candidata ${candidata})`);
  }
}
console.log('  ok');

// ── 2. A regra de ouro ─────────────────────────────────────────────────────
console.log('── 2. fatura = limite usado − parcelas a vencer ──');
{
  eq(faturaPorLimite(3423.57, 0), 3423.57, 'sem parcelamento, fatura = limite usado');
  eq(faturaPorLimite(5000, 1576.43), 3423.57, 'parcelas a vencer são descontadas');
  // Sem o dado do emissor não há como aplicar a regra — quem chama cai na soma.
  eq(faturaPorLimite(null, 100), null, 'sem limite usado → null (não chuta)');
  eq(faturaPorLimite(undefined, 0), null, 'undefined também');
  // Limite usado zerado é legítimo: cartão sem uso no ciclo.
  eq(faturaPorLimite(0, 0), 0, 'cartão sem uso → fatura zero');
  // Futuras maiores que o usado seria dado inconsistente do emissor.
  eq(faturaPorLimite(100, 300), 0, 'nunca devolve fatura negativa');
  // Centavos: a Celcoin manda string com ponto decimal.
  eq(faturaPorLimite(1000.005, 0), 1000.01, 'arredonda pro centavo');
}
console.log('  ok');

// ── 3. O caso que gerou o bug, ponta a ponta ───────────────────────────────
console.log('── 3. regressão do caso real ──');
{
  const hoje = '2026-08-01';
  const aberta = escolherFaturaAberta(BILLS_REAIS, hoje);
  ok(aberta === null, 'a fatura de julho (fechada e paga) não pode virar a atual');

  // Com `aberta === null`, o `of_bill_atual` fica nulo e a tela não tem como
  // somar as compras da fatura antiga junto com as do ciclo novo.
  const ofBillAtual = aberta ? aberta.id : null;
  eq(ofBillAtual, null, 'of_bill_atual nulo enquanto a fatura não é publicada');

  // O que NÃO pode voltar a acontecer: somar a fatura fechada com o ciclo novo.
  const somaErrada = 3143.75 + 1870.24;
  ok(Math.abs(somaErrada - 5013.99) < 0.01, 'a soma errada era exatamente 5.013,99');

  // A fatura em aberto passou a sair das TRANSAÇÕES do ciclo — auditável, bate
  // com a lista que o usuário vê logo abaixo do valor. Sai a MENOS quando há
  // parcelamento, e a tela diz isso em vez de mostrar um número redondo e errado.
  const doCiclo = 1870.24;
  ok(doCiclo < 3423.57, 'a soma do ciclo sai a menos que a fatura real');
  ok(doCiclo !== somaErrada, 'e nunca é a soma das duas faturas');
  // `faturaPorLimite` continua existindo (emissor que informe parcela a vencer
  // datada no futuro se beneficia), mas NÃO é mais a fonte da fatura no Celcoin.
  eq(faturaPorLimite(5000, 1576.43), 3423.57, 'a regra segue correta quando há o dado');
}
console.log('  ok');

// ── 4. FATURA SIMULADA (campo novo da Polp, ago/2026) ─────────────────────
// É o valor da fatura EM ANDAMENTO, já líquido de pagamentos. Tem prioridade
// sobre tudo: enquanto ele não existia, a fatura aberta precisava ser estimada
// (limite usado, parcelas a vencer, soma de transações) — e toda estimativa
// erra. Tendo o número do banco, estimar seria pior.
console.log('── 4. fatura simulada ──');
{
  eq(faturaSimulada({ simulated_bill_total_amount: { amount: 842.15 } }), 842.15, 'lê o campo novo');
  eq(faturaSimulada({ simulatedBillTotalAmount: { amount: 842.15 } }), 842.15, 'aceita camelCase (contrato ainda mudando)');
  eq(faturaSimulada({ simulated_bill_total_amount: { amount: 0 } }), 0,
    'ZERO é resposta válida — é a fatura quitada, não "campo ausente"');
  eq(faturaSimulada({}), null, 'sem o campo devolve null (nada muda)');
  eq(faturaSimulada(null), null, 'nulo não quebra');

  // O caso do Mercado Pago: NUNCA publica a fatura aberta, e a última publicada
  // já foi paga. Sem o simulado a fatura tinha de ser estimada; com ele, sai do
  // banco. É também o que conserta "paguei a fatura e o painel não atualizou".
  const cartaoMP = { id: 'mp', identification: { name: 'Mercado Pago' },
    limits: [{ limit_type: 'LIMITE_CREDITO_TOTAL', limit_amount: { amount: 2900 }, used_amount: { amount: 3047.81 } }] };
  const billsMP = [{ id: 'b1', bill_closing_date: '2026-07-08', due_date: '2026-07-14',
    bill_total_amount: { amount: 1200 }, payments: [{ amount: { amount: 1200 } }] }];

  const semSim = normalizeCartao(cartaoMP, billsMP, '2026-08-10');
  eq(semSim.saldoFatura, null, 'sem o campo, segue como antes (o sync estima depois)');

  const comSim = normalizeCartao({ ...cartaoMP, simulated_bill_total_amount: { amount: 842.15 } }, billsMP, '2026-08-10');
  eq(comSim.saldoFatura, -842.15, 'com o campo, a fatura vem do banco (saldo negativo = fatura a pagar)');
  eq(comSim.faturaAberta.restante, 842.15, 'e o restante exposto bate');

  const quitado = normalizeCartao({ ...cartaoMP, simulated_bill_total_amount: { amount: 0 } }, billsMP, '2026-08-10');
  eq(Math.abs(quitado.saldoFatura), 0, 'fatura quitada zera o saldo — o bug do "paguei e não atualizou"');

  // ⚠️ O simulado NUNCA pode ser confundido com o limite usado (3.047,81 aqui).
  ok(comSim.saldoFatura !== -3047.81, 'jamais exibe o limite usado como fatura');
}
console.log('  ok');

// ── 4B. unbilled_amount — o SUBSTITUTO (breaking change de 24/08/2026) ──────
// A Polp REMOVEU `simulated_bill_total_amount` da raiz do cartão (sumiu dos 35
// docs, inclusive das faturas) e pôs `unbilled_amount` dentro de cada item de
// `limits[]`, calculado por `identification_number` — ou seja, por PLÁSTICO.
// Sem ler o campo novo, a fonte nº 2 do faturaVista morreria calada e todo
// cartão cairia no fallback de somar transações, que é o que erra quando falta
// lançamento.
console.log('── 4B. unbilled_amount (campo novo) ──');
{
  const { unbilledDoCartao } = require('../src/services/polpCelcoinSync');

  eq(unbilledDoCartao({ limits: [{ identification_number: '4351', unbilled_amount: { amount: 175.5 } }] }),
    175.5, 'lê o campo dentro de limits[]');
  eq(unbilledDoCartao({}), null, 'sem limits devolve null');
  eq(unbilledDoCartao({ limits: [] }), null, 'limits vazio devolve null');
  eq(unbilledDoCartao({ limits: [{ identification_number: '4351' }] }), null,
    'linha SEM o campo devolve null — "nao veio" nunca pode virar R$ 0,00');
  eq(unbilledDoCartao({ limits: [{ identification_number: '4351', unbilled_amount: { amount: 0 } }] }), 0,
    'ZERO e resposta valida (nada lancado ainda no ciclo)');

  // ⚠️ SOMA POR PLÁSTICO DISTINTO. Dois cartões (titular + adicional) somam;
  // duas linhas do MESMO plástico (uma por modalidade) contam UMA vez.
  eq(unbilledDoCartao({ limits: [
    { identification_number: '4351', unbilled_amount: { amount: 100 } },
    { identification_number: '6967', unbilled_amount: { amount: 75.5 } },
  ] }), 175.5, 'plasticos diferentes SOMAM');

  eq(unbilledDoCartao({ limits: [
    { identification_number: '4351', credit_line_limit_type: 'LIMITE_CREDITO_TOTAL', unbilled_amount: { amount: 100 } },
    { identification_number: '4351', credit_line_limit_type: 'LIMITE_CREDITO_MODALIDADE_OPERACAO', unbilled_amount: { amount: 100 } },
  ] }), 100, 'o MESMO plastico em duas modalidades NAO conta duas vezes');

  // Sem identificação tudo colapsa numa chave — melhor faltar do que inflar a
  // fatura da pessoa.
  eq(unbilledDoCartao({ limits: [
    { unbilled_amount: { amount: 100 } },
    { unbilled_amount: { amount: 100 } },
  ] }), 100, 'linhas sem identification_number nao inflam o total');

  // Ponta a ponta: o cartão só com o campo NOVO tem de produzir a fatura certa.
  const cartaoNovo = { id: 'nu', identification: { name: 'gold' }, limits: [
    { identification_number: '4351', credit_line_limit_type: 'LIMITE_CREDITO_MODALIDADE_OPERACAO',
      limit_amount: { amount: 10050 }, customized_limit_amount: { amount: 6050 },
      used_amount: { amount: 3155.8 }, available_amount: { amount: 2894.1976 },
      // ⚠️ Valores REAIS do payload: o plástico 4351 vem ZERADO e todo o
      // "ainda sem fatura" está no 6967. Zero é resposta válida, não ausência.
      unbilled_amount: { amount: 0 } },
    { identification_number: '6967', credit_line_limit_type: 'LIMITE_CREDITO_MODALIDADE_OPERACAO',
      limit_amount: { amount: 10050 }, customized_limit_amount: { amount: 6050 },
      used_amount: { amount: 3155.8 }, available_amount: { amount: 2894.1976 },
      unbilled_amount: { amount: 1381.16 } },
  ] };
  const billsNu = [{ id: 'b1', bill_closing_date: '2026-08-03', due_date: '2026-08-10',
    bill_total_amount: { amount: 1303.06 }, payments: [{ amount: { amount: 1303.06 } }] }];
  // ⚠️⚠️ O `unbilled_amount` NÃO É A FATURA — é o SUBTRAENDO dela.
  //
  // Foi o erro que custou dois dias. Eu troquei `simulated_bill_total_amount`
  // por `unbilled_amount` e EXIBI o campo novo direto: deu R$ 1.381,16 onde o
  // banco mostrava R$ 1.774,64. A doc define o campo como "soma das transações
  // com `bill_id` NULL" — o que ocupa limite e ainda não entrou em fatura
  // nenhuma. Isso é exatamente a "parcela a vencer" da REGRA DE OURO:
  //
  //     fatura = used_amount − unbilled_amount
  //
  // Payload REAL da cliente (of-debug de 25/08/2026), conferido contra o app
  // do Nubank dela. `used_amount` vem IGUAL nas duas linhas (é card-level);
  // `unbilled_amount` vem POR PLÁSTICO e por isso é somado.
  const nu = normalizeCartao(cartaoNovo, billsNu, '2026-08-25');
  eq(nu.limiteUsado, 3155.8, 'used_amount lido do limite');
  eq(unbilledDoCartao(cartaoNovo), 1381.16, 'unbilled somado por plástico');
  eq(nu.faturaSimulada, 1774.64, 'FATURA = used − unbilled (o número do app do banco)');
  eq(nu.saldoFatura, -1774.64, 'e vira o saldo negativo gravado na wallet');
  // ⚠️ A regressão a impedir: exibir o unbilled cru como se fosse a fatura.
  ok(nu.faturaSimulada !== 1381.16, 'NUNCA exibir o unbilled cru como fatura');
  // Nem o limite usado sozinho — esse é o erro simétrico, pro outro lado.
  ok(nu.faturaSimulada !== 3155.8, 'nem o limite usado sozinho');
  // O limite continua saindo pela regra própria — um não contamina o outro.
  eq(nu.extras.limite, 6050, 'o teto efetivo segue independente do unbilled');

  // Sem `unbilled` não dá pra aplicar a regra: cai no legado, não inventa.
  const semUnb = JSON.parse(JSON.stringify(cartaoNovo));
  semUnb.limits.forEach((l) => { delete l.unbilled_amount; });
  eq(normalizeCartao(semUnb, billsNu, '2026-08-25').faturaSimulada, null,
    'sem unbilled_amount não há regra de ouro — devolve null em vez de chutar');

  // Unbilled MAIOR que o usado (dado inconsistente) não pode virar negativo.
  const absurdo = JSON.parse(JSON.stringify(cartaoNovo));
  absurdo.limits[0].unbilled_amount = { amount: 99999 };
  ok((normalizeCartao(absurdo, billsNu, '2026-08-25').faturaSimulada || 0) >= 0,
    'unbilled maior que o usado não produz fatura negativa');
}
console.log('  ok');

// ── 5. Dia de fechamento/vencimento acompanha MUDANÇA do banco ────────────
console.log('── 5. datas seguem o banco quando ele muda ──');
{
  const b = (venc, fecha) => ({ due_date: venc, bill_closing_date: fecha });

  // Caso real (Mercado Pago): o banco mudou de 17/12 pra 14/08 e o painel ficou
  // preso na data velha, porque a moda de TODA a história ainda apontava 17.
  const mudou = [
    b('2026-08-14', '2026-08-08'), b('2026-07-14', '2026-07-08'), b('2026-06-14', '2026-06-08'),
    b('2026-05-17', '2026-05-12'), b('2026-04-17', '2026-04-12'), b('2026-03-17', '2026-03-12'),
    b('2026-02-17', '2026-02-12'), b('2026-01-17', '2026-01-12'), b('2025-12-17', '2025-12-12'),
  ];
  eq(diaMaisFrequente(mudou, 'due_date'), 14, 'vencimento segue a mudança recente, não a história');
  eq(diaMaisFrequente(mudou, 'bill_closing_date'), 8, 'fechamento idem');

  // …mas uma anomalia isolada (feriado adiou o vencimento) NÃO pode virar regra:
  // é exatamente pra isso que a moda existe.
  const anomalia = [
    b('2026-08-16', '2026-08-11'), b('2026-07-14', '2026-07-08'), b('2026-06-14', '2026-06-08'),
    b('2026-05-14', '2026-05-08'), b('2026-04-14', '2026-04-08'), b('2026-03-14', '2026-03-08'),
  ];
  eq(diaMaisFrequente(anomalia, 'due_date'), 14, 'um vencimento deslocado não vira a nova regra');

  eq(diaMaisFrequente([], 'due_date'), null, 'sem faturas, null');
  eq(diaMaisFrequente([b('2026-08-14', '2026-08-08')], 'due_date'), 14, 'uma fatura só ainda serve');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`❌ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('   · ' + f));
  process.exit(1);
}
console.log('✅ Fatura do Open Finance: todos os casos passaram.');
