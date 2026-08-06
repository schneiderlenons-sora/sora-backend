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
const { normalizeTxConta } = require('../src/services/polpCelcoinSync');

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

// ── Resultado ──────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ pagamento de fatura: todos os casos passaram');
