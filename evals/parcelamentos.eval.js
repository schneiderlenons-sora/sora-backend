// =============================================================================
// EVAL da análise de PARCELAMENTOS do Open Finance (trilho Celcoin).
//
// POR QUE EXISTE: o Open Finance não tem identificador único da compra
// parcelada. A Polp agrupa as parcelas por heurística (descrição + valor +
// data + nº de parcelas) e, no Nubank, parcelas da MESMA compra chegam com
// datas diferentes — a mesma compra virava DOIS parcelamentos. Medido na conta
// real: três linhas do mesmo Mercado Livre, com paidInstallments 5, 3 e 1.
//
// A Polp corrigiu ~90% dos casos (suporte, ago/2026). `analisarParcelamentos`
// é o instrumento que MEDE se a correção chegou, em vez de conferir JSON no
// olho — e este eval trava o comportamento do instrumento.
//
// Rodar:  npm run eval:parcelamentos
// =============================================================================
const {
  analisarParcelamentos, normalizeParcelamento, assinaturaCompra,
} = require('../src/services/polpCelcoinSync');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// ── 1. Normalização tolerante a camelCase / snake_case ─────────────────────
console.log('── 1. normalização ──');
{
  const camel = normalizeParcelamento({
    description: 'HOTEIS.COM', amount: { amount: '-150.00', currency: 'BRL' },
    totalInstallments: 12, paidInstallments: 3, occurrences: ['a', 'b', 'c'],
  });
  eq(camel.valorParcela, 150, 'valor da parcela vem positivo (débito é negativo na API)');
  eq(camel.totalParcelas, 12, 'totalInstallments');
  eq(camel.parcelasEncontradas, 3, 'paidInstallments');

  const snake = normalizeParcelamento({
    description: 'X', amount: '-99.90', total_installments: 6, paid_installments: 2, occurrences: [],
  });
  eq(snake.totalParcelas, 6, 'total_installments (snake) também é lido');
  eq(snake.valorParcela, 99.9, 'amount como string pura');

  // Sem paidInstallments, cai no tamanho de occurrences[].
  const semPaid = normalizeParcelamento({
    description: 'Y', amount: -50, totalInstallments: 4, occurrences: ['1', '2'],
  });
  eq(semPaid.parcelasEncontradas, 2, 'sem paidInstallments usa len(occurrences)');
}
console.log('  ok');

// ── 2. Assinatura ignora o marcador de parcela ─────────────────────────────
// É o ponto todo: "HOTEIS.COM 3/12" e "HOTEIS.COM 12/12" são a MESMA compra.
console.log('── 2. assinatura da compra ──');
{
  const a = normalizeParcelamento({ description: 'HOTEIS.COM 3/12',  amount: -150, totalInstallments: 12, paidInstallments: 3 });
  const b = normalizeParcelamento({ description: 'HOTEIS.COM 12/12', amount: -150, totalInstallments: 12, paidInstallments: 1 });
  eq(assinaturaCompra(a), assinaturaCompra(b), 'marcador de parcela não separa a mesma compra');

  // Acento não pode separar.
  const c1 = normalizeParcelamento({ description: 'MAGAZINE LUÍZA', amount: -80, totalInstallments: 10, paidInstallments: 2 });
  const c2 = normalizeParcelamento({ description: 'MAGAZINE LUIZA', amount: -80, totalInstallments: 10, paidInstallments: 1 });
  eq(assinaturaCompra(c1), assinaturaCompra(c2), 'acento não separa a mesma compra');

  // Mas valor diferente é compra diferente (não pode colapsar demais).
  const d = normalizeParcelamento({ description: 'HOTEIS.COM', amount: -151, totalInstallments: 12, paidInstallments: 3 });
  ok(assinaturaCompra(a) !== assinaturaCompra(d), 'valor de parcela diferente = compra diferente');
}
console.log('  ok');

// ── 3. O BUG REAL: mesmo Mercado Livre em 3 linhas ─────────────────────────
console.log('── 3. duplicata (caso medido na conta real) ──');
{
  const bugado = [
    { description: 'MERCADO LIVRE 5/10',  amount: -100, totalInstallments: 10, paidInstallments: 5 },
    { description: 'MERCADO LIVRE 3/10',  amount: -100, totalInstallments: 10, paidInstallments: 3 },
    { description: 'MERCADO LIVRE 1/10',  amount: -100, totalInstallments: 10, paidInstallments: 1 },
  ];
  const r = analisarParcelamentos(bugado);
  eq(r.parcelamentos, 3, 'três linhas na API');
  eq(r.compras_distintas, 1, 'mas UMA compra só');
  eq(r.duplicatas, 1, 'um grupo duplicado detectado');

  // Cru conta as três: (10-5) + (10-3) + (10-1) = 5+7+9 = 21 parcelas × 100
  eq(r.futuras.cru.todas_restantes, 2100, 'leitura CRUA infla (soma as 3 linhas)');
  // Deduplicado mantém a linha mais completa (paid=5): 10-5 = 5 × 100
  eq(r.futuras.deduplicado.todas_restantes, 500, 'deduplicado usa a linha mais completa');
  eq(r.futuras.deduplicado.fora_da_aberta, 400, 'descontando a parcela da fatura aberta');

  eq(r.detalhe_duplicatas[0].linhas, 3, 'detalhe informa quantas linhas');
  eq(r.detalhe_duplicatas[0].parcelas_encontradas.length, 3, 'detalhe lista o paidInstallments de cada');
}
console.log('  ok');

// ── 4. Dado JÁ CORRIGIDO pela Polp ─────────────────────────────────────────
// É este o resultado esperado quando a correção chega: duplicatas 0 e as duas
// colunas (cru × deduplicado) IGUAIS — não há mais o que deduplicar.
console.log('── 4. dado corrigido ──');
{
  const corrigido = [
    { description: 'MERCADO LIVRE', amount: -100, totalInstallments: 10, paidInstallments: 5 },
    { description: 'HOTEIS.COM',    amount: -150, totalInstallments: 12, paidInstallments: 3 },
  ];
  const r = analisarParcelamentos(corrigido);
  eq(r.duplicatas, 0, 'sem duplicata');
  eq(r.compras_distintas, 2, 'duas compras distintas');
  // (10-5)*100 + (12-3)*150 = 500 + 1350 = 1850
  eq(r.futuras.cru.todas_restantes, 1850, 'soma das parcelas restantes');
  eq(r.futuras.cru.todas_restantes, r.futuras.deduplicado.todas_restantes,
     'sem duplicata, cru e deduplicado são IGUAIS (é o sinal de que corrigiu)');
}
console.log('  ok');

// ── 5. Bordas ──────────────────────────────────────────────────────────────
console.log('── 5. bordas ──');
{
  eq(analisarParcelamentos([]).parcelamentos, 0, 'lista vazia não quebra');
  eq(analisarParcelamentos(null).duplicatas, 0, 'null não quebra');
  eq(analisarParcelamentos(undefined).compras_distintas, 0, 'undefined não quebra');

  // Parcelamento já quitado não pode virar "futura" negativa.
  const quitado = analisarParcelamentos([
    { description: 'QUITADO', amount: -100, totalInstallments: 3, paidInstallments: 3 },
  ]);
  eq(quitado.futuras.cru.todas_restantes, 0, 'quitado não gera parcela futura');
  eq(quitado.futuras.cru.fora_da_aberta, 0, 'nem negativa ao descontar a aberta');

  // Lixo (sem total ou sem valor) é descartado em vez de virar NaN.
  const lixo = analisarParcelamentos([
    { description: 'SEM TOTAL', amount: -100 },
    { description: 'SEM VALOR', totalInstallments: 5 },
  ]);
  eq(lixo.parcelamentos, 0, 'linha sem total/valor é descartada (não vira NaN)');
  ok(Number.isFinite(lixo.futuras.cru.todas_restantes), 'soma continua finita');
}
console.log('  ok');

// ── Resultado ──────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ análise de parcelamentos: todos os casos passaram');
