// =============================================================================
// EVAL do pagamento de fatura visto pelo lado da CONTA.
//
// ESCRITO A PARTIR DE UMA REGRESSÃO REAL. O caso: fatura do Mercado Pago paga
// em 03/08/2026, R$ 2.243,60. Ela aparece nos DOIS lados —
//   · no CARTÃO   → entrou certo (transferência, categoria Fatura);
//   · na CONTA    → entrou como Gasto/Outros e voltou a inflar o relatório e
//                   o gráfico "Despesas por categoria" (73% em Outros).
//
// Por que conta em dobro: cada compra da fatura JÁ foi categorizada uma a uma.
// O pagamento é a quitação, não um gasto novo.
//
// A causa: a detecção por descrição existia SÓ no trilho Pluggy
// (services/pluggySync.js) e não foi portada pro trilho Celcoin, que confiava
// apenas no `category_ref` — e o Mercado Pago não manda
// LOAN_PAYMENTS_CREDIT_CARD_PAYMENT nessa linha.
//
// Agora a regra é fonte única em services/categorizar. Este eval existe pra
// impedir que um trilho novo volte a nascer sem ela.
//
// Rodar:  npm run eval:pagamento-fatura
// =============================================================================
const { ehPagamentoFaturaDescricao, CATEGORIA_FATURA } = require('../src/services/categorizar');
const { normalizeTxConta, normalizeTxCartao } = require('../src/services/polpCelcoinSync');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// ── 1. Descrições que SÃO pagamento de fatura ──────────────────────────────
console.log('── 1. detecta o pagamento ──');
{
  const sim = [
    'Pagamento Cartão de crédito',   // ← o caso real do Mercado Pago
    'Pagamento da fatura',           // ← "da" faltava no regex original
    'Pagamento de fatura',
    'Pagamento fatura',
    'PAGAMENTO DA FATURA CARTAO',
    'Pgto cartao',
    'Pagto da fatura',
    'PGTO FATURA NUBANK',
    'Credit Card Payment',
    'Fatura do cartao',
    'Pag fatura',
  ];
  for (const d of sim) ok(ehPagamentoFaturaDescricao(d), `"${d}" deveria ser pagamento de fatura`);
}
console.log('  ok');

// ── 2. Falso positivo é PIOR que falso negativo ────────────────────────────
// Marcar como transferência some com o gasto do relatório. Errar aqui esconde
// dinheiro que o usuário gastou de verdade.
console.log('── 2. o que NÃO pode virar transferência ──');
{
  const nao = [
    'Pagamento Pix Joao',
    'Cartao de credito Shell',       // compra NUM cartão, não pagamento DELE
    'Pagamento boleto energia',
    'Pagamento salario',
    'Compra cartao mercado',
    'Pagamento aluguel',
    'Uber',
    'Recarga celular',
    '',
  ];
  for (const d of nao) ok(!ehPagamentoFaturaDescricao(d), `"${d}" NÃO pode ser pagamento de fatura`);
  ok(!ehPagamentoFaturaDescricao(null), 'null não quebra');
  ok(!ehPagamentoFaturaDescricao(undefined), 'undefined não quebra');
}
console.log('  ok');

// ── 3. O caso real, ponta a ponta pelo trilho Celcoin ──────────────────────
console.log('── 3. caso real (Mercado Pago, 03/08, R$ 2.243,60) ──');
{
  // Como a Celcoin manda: SEM category_ref de pagamento de cartão.
  const n = normalizeTxConta({
    id: 'tx-real',
    transaction_name: 'Pagamento Cartão de crédito',
    transaction_amount: { amount: '2243.60', currency: 'BRL' },
    credit_debit_type: 'DEBITO',
    transaction_date_time: '2026-08-03T10:00:00Z',
  });
  eq(n.transferencia, true, 'entra como TRANSFERÊNCIA (não conta no relatório)');
  eq(n.categoria, CATEGORIA_FATURA, 'e na categoria Fatura, não em Outros');

  // Com o category_ref, continua funcionando (não regredir o caminho antigo).
  const comRef = normalizeTxConta({
    id: 'tx-ref',
    transaction_name: 'Qualquer nome',
    transaction_amount: { amount: '100' },
    credit_debit_type: 'DEBITO',
    category_ref: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
  });
  eq(comRef.transferencia, true, 'category_ref sozinho ainda basta');
  eq(comRef.categoria, CATEGORIA_FATURA, 'e também cai em Fatura');

  // Transferência comum continua sendo Transferências, NÃO Fatura.
  const transf = normalizeTxConta({
    id: 'tx-transf',
    transaction_name: 'TED para conta propria',
    transaction_amount: { amount: '300' },
    credit_debit_type: 'DEBITO',
    category_ref: 'TRANSFER_OUT_ACCOUNT_TRANSFER',
  });
  eq(transf.transferencia, true, 'transferência entre contas segue transferência');
  eq(transf.categoria, 'Transferências', 'mas a categoria é Transferências, não Fatura');

  // Gasto normal não pode virar transferência.
  const gasto = normalizeTxConta({
    id: 'tx-gasto',
    transaction_name: 'Supermercado Extra',
    transaction_amount: { amount: '150' },
    credit_debit_type: 'DEBITO',
  });
  eq(gasto.transferencia, false, 'compra comum continua gasto');
}
console.log('  ok');

// ── 4B. "Pagamento recebido" NO CARTÃO (Nubank) ────────────────────────────
//
// O bug mais caro deste arquivo. O Nubank descreve o pagamento da fatura como
// "Pagamento recebido" — sem "fatura", sem "cartão". O detector compartilhado
// exige as duas palavras juntas (senão "pagamento pix" numa conta viraria
// transferência), então a linha caía em crédito de ajuste → Reembolso → e
// ABATIA a fatura. A fatura do app ficava MENOR que a do banco: medido numa
// conta real, R$ 2.293,71 de abatimento indevido levaram a soma do ciclo a
// −R$ 2.256,09.
console.log('── 4B. "Pagamento recebido" no cartão ──');
{
  const hoje = '2026-08-13';
  const pg = normalizeTxCartao({
    id: 'tx-nu-1',
    transaction_name: 'Pagamento recebido',
    brazilian_amount: { amount: '2293.71' },
    credit_debit_type: 'CREDITO',
    transaction_date_time: '2026-08-07T10:00:00Z',
  }, hoje);
  eq(pg.categoria, CATEGORIA_FATURA, 'vira pagamento de FATURA, não Reembolso');
  eq(pg.transferencia, true, 'e segue como transferência (fora do gasto)');

  // O campo ESTRUTURADO da Polp também tem de bastar sozinho — é o caminho
  // mais confiável, e o regex antigo não casava com ele: "credit_card_payment"
  // tem UNDERSCORE, e o padrão pedia \s* entre as palavras.
  const porRef = normalizeTxCartao({
    id: 'tx-nu-2',
    transaction_name: 'Qualquer coisa',
    brazilian_amount: { amount: '500' },
    credit_debit_type: 'CREDITO',
    category_ref: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT',
    transaction_date_time: '2026-08-07T10:00:00Z',
  }, hoje);
  eq(porRef.categoria, CATEGORIA_FATURA, 'category_ref sozinho já identifica o pagamento');

  // ⚠️ O QUE NÃO PODE SER CONFUNDIDO — estes continuam ABATENDO a fatura,
  // porque são consumo que voltou, não quitação:
  const estorno = normalizeTxCartao({
    id: 'tx-nu-3',
    transaction_name: 'Estorno de Uber - NuPay',
    brazilian_amount: { amount: '66.95' },
    credit_debit_type: 'CREDITO',
    transaction_date_time: '2026-08-12T10:00:00Z',
  }, hoje);
  ok(estorno.categoria !== CATEGORIA_FATURA, 'estorno NÃO vira pagamento de fatura');

  const credParc = normalizeTxCartao({
    id: 'tx-nu-4',
    transaction_name: 'Crédito de parcelamento de compra',
    brazilian_amount: { amount: '88.96' },
    credit_debit_type: 'CREDITO',
    transaction_date_time: '2026-08-07T10:00:00Z',
  }, hoje);
  ok(credParc.categoria !== CATEGORIA_FATURA,
    'crédito de parcelamento NÃO vira pagamento (ele abate, e as parcelas somam)');

  // DÉBITO com a mesma descrição não é quitação — é cobrança.
  const debito = normalizeTxCartao({
    id: 'tx-nu-5',
    transaction_name: 'Pagamento recebido',
    brazilian_amount: { amount: '100' },
    credit_debit_type: 'DEBITO',
    transaction_date_time: '2026-08-07T10:00:00Z',
  }, hoje);
  ok(debito.categoria !== CATEGORIA_FATURA, 'débito com a mesma descrição não é pagamento de fatura');
}
console.log('  ok');

// ── 5. Qual FATURA o pagamento quitou ──────────────────────────────────────
//
// Segunda metade do mesmo bug: o pagamento entrava como transação e parava aí.
// Nada chegava em `pagamentos_fatura`, que é de onde sai `restante = fatura −
// pago` — então a fatura ficava "em aberto" pra sempre no painel, mesmo depois
// de o usuário ter pago (queixa real de cliente do Mercado Pago).
//
// A competência é a do vencimento MAIS PRÓXIMO da data do pagamento — mesma
// ideia de `vencimentoCoberto` (services/vencimentoDivida.js). Escolher sempre
// "a próxima a vencer" jogaria todo pagamento atrasado pra fatura errada.
console.log('── 5. competência que o pagamento quitou ──');
{
  const { competenciaDoPagamento } = require('../src/services/faturaRollover');
  const CARTAO = { dia_fechamento: 8, dia_vencimento: 13 };   // o cartão do caso

  // Os dois pagamentos REAIS medidos na conta do cliente.
  eq(competenciaDoPagamento(CARTAO, '2026-08-09'), '2026-08',
    'pagou 09/08 a fatura que fechou 08/08 e vence 13/08');
  eq(competenciaDoPagamento(CARTAO, '2026-08-03'), '2026-08',
    'pagou 03/08 (antecipado): 10 dias do venc de agosto × 21 do de julho');

  // Atrasado: NÃO pode pular pra fatura seguinte.
  eq(competenciaDoPagamento(CARTAO, '2026-07-20'), '2026-07',
    'pagou 20/07 com atraso — quita a de julho, não a de agosto');
  eq(competenciaDoPagamento(CARTAO, '2026-08-14'), '2026-08',
    'um dia depois do vencimento ainda é a fatura daquele vencimento');

  // Vira o ano.
  eq(competenciaDoPagamento(CARTAO, '2026-01-02'), '2026-01',
    'início de janeiro quita a de janeiro (venc 13/01), não a de dezembro');

  // Sem ciclo configurado não dá pra afirmar competência — melhor não gravar.
  eq(competenciaDoPagamento({ dia_fechamento: null, dia_vencimento: null }, '2026-08-09'), null,
    'cartão sem dia de vencimento não gera pagamento_fatura');
}
console.log('  ok');

// ── 6. "Paga depois do fechamento" — a regra pra virar de fatura ───────────
//
// Só se pode dar a fatura por encerrada (e passar pra seguinte) quando existe
// pagamento DEPOIS da data de fechamento que cobre o valor dela.
//
// Pagamento ANTES do fechamento NÃO conta. No Mercado Pago é comum abater a
// fatura em curso aos poucos: nesta conta real a fatura de agosto era de
// R$ 2.804,28, levou R$ 2.243,60 no dia 03 (fechando dia 08) e o banco passou a
// publicar R$ 560,68 — ela seguia aberta. Quem a encerrou foi o pagamento de
// R$ 565,68 no dia 09, DEPOIS do fechamento.
console.log('── 6. paga depois do fechamento ──');
{
  const { quitadaDepoisDoFechamento } = require('../src/services/faturaRollover');
  const CICLO = { ini: '2026-07-09', fim: '2026-08-08', venc: '2026-08-13' };

  // O caso real, com os dois pagamentos.
  const reais = [
    { valor: 2243.60, data: '2026-08-03' },   // antes do fechamento: abate, não encerra
    { valor:  565.68, data: '2026-08-09' },   // depois: encerra
  ];
  eq(quitadaDepoisDoFechamento(reais, 560.68, CICLO), true,
    'R$ 565,68 pagos em 09/08 cobrem a fatura de R$ 560,68 que fechou em 08/08');

  eq(quitadaDepoisDoFechamento([reais[0]], 560.68, CICLO), false,
    'só o abatimento de 03/08 NÃO encerra a fatura — ela ainda vai fechar');

  // Pagamento parcial depois do fechamento também não encerra.
  eq(quitadaDepoisDoFechamento([{ valor: 300, data: '2026-08-10' }], 560.68, CICLO), false,
    'pagamento parcial depois do fechamento não quita');

  // Um centavo de folga (arredondamento do emissor).
  eq(quitadaDepoisDoFechamento([{ valor: 560.67, data: '2026-08-10' }], 560.68, CICLO), true,
    'diferença de 1 centavo conta como quitada');

  // Bordas.
  eq(quitadaDepoisDoFechamento([], 560.68, CICLO), false, 'sem pagamento não quita');
  eq(quitadaDepoisDoFechamento(reais, 0, CICLO), false,
    'fatura zerada não é "quitada" — não há o que encerrar');
  eq(quitadaDepoisDoFechamento(reais, 560.68, null), false, 'sem ciclo não decide');
  eq(quitadaDepoisDoFechamento([{ valor: 999, data: '2026-08-08' }], 560.68, CICLO), false,
    'pagamento NO dia do fechamento ainda é "durante o ciclo"');
}
console.log('  ok');

// ── Resultado ──────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ pagamento de fatura: todos os casos passaram');
