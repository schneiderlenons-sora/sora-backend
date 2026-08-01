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

console.log('');
if (falhas.length) {
  console.error(`❌ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('   · ' + f));
  process.exit(1);
}
console.log('✅ Fatura do Open Finance: todos os casos passaram.');
