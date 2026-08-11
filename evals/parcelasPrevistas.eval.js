// =============================================================================
// EVAL das parcelas a vencer (fatura futura).
//
// CASO DE ORIGEM (conta real, ago/2026): a fatura de setembro saía R$ 282,27
// onde o banco mostrava R$ 558,78. Faltavam exatamente três parcelas:
//     Prosed 79,86 · PayU Adidas 139,99 · Chinoca 56,66  =  R$ 276,51
//
// Os dois riscos que este eval trava:
//  · DEDUP DEMAIS → some parcela de verdade e a fatura sai menor que a do banco;
//  · DEDUP DE MENOS → a duplicata da Polp conta duas vezes e a fatura sai maior.
//
// E a regra de que a projeção é guiada por DATA, nunca por `paidInstallments`:
// a Polp erra esse campo (o Chinoca vinha "3 de 3 pagas" com 1 por vencer).
//
// Rodar:  npm run eval:parcelas-previstas
// =============================================================================
const { deduplicar, projetar, daCompetencia, jaEhTransacao } = require('../src/services/parcelasPrevistas');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// Cartão real do caso: fecha dia 8, vence dia 13.
const CARTAO = { dia_fechamento: 8, dia_vencimento: 13 };
const HOJE = '2026-08-11';   // competência atual = 2026-08

// Payload REAL do endpoint `parcelamentos` (com as duplicatas da Polp).
const REAIS = [
  { description: 'CHINOCA', amount: -56.67, totalInstallments: 3, paidInstallments: 3,
    purchasedAt: '2026-06-20T18:15:06.000000Z', occurrences: ['a', 'b', 'c'] },
  { description: 'JIM.COM PROSED ES', amount: -79.86, totalInstallments: 2, paidInstallments: 1,
    purchasedAt: '2026-08-03T22:31:55.000000Z', occurrences: ['d'] },
  { description: 'JIM.COM PROSED ESPECIALID', amount: -79.87, totalInstallments: 2, paidInstallments: 1,
    purchasedAt: '2026-08-03T22:31:55.000000Z', occurrences: ['e'] },
  { description: 'PayU *ADIDAS', amount: -140, totalInstallments: 2, paidInstallments: 1,
    purchasedAt: '2026-07-14T03:14:02.000000Z', occurrences: ['f'] },
  { description: 'PayU *ADI', amount: -139.99, totalInstallments: 2, paidInstallments: 1,
    purchasedAt: '2026-07-14T03:14:02.000000Z', occurrences: ['g'] },
];

// ── 1. O NÚMERO DO CLIENTE ──────────────────────────────────────────────
console.log('── 1. a fatura de setembro fecha com o banco ──');
{
  const previstas = projetar(REAIS, CARTAO, HOJE);
  const set = daCompetencia(previstas, '2026-09');
  eq(set.linhas.length, 3, 'são TRÊS linhas, não cinco (as duplicatas foram fundidas)');

  const valores = set.linhas.map((l) => l.valor).sort((a, b) => a - b);
  eq(JSON.stringify(valores), JSON.stringify([56.67, 79.86, 139.99]),
    'os valores são os que a API informa');

  // ⚠️ R$ 276,52 aqui × R$ 276,51 no app do banco — UM CENTAVO, e é esperado.
  // A API informa a parcela NOMINAL (Chinoca 56,67); numa compra de 3x o
  // arredondamento sobra na ÚLTIMA parcela, que o banco cobra 56,66. Não existe
  // no payload o total da compra pra recalcular isso — inventar a diferença
  // seria pior que assumi-la. Por isso a projeção é EXIBIDA como "prevista pelo
  // banco": ela aproxima, não promete o centavo.
  eq(set.total, 276.52, 'soma das parcelas de setembro (1 centavo acima do app, ver acima)');
  eq(Math.round((282.27 + set.total) * 100) / 100, 558.79,
    'somado ao que já existia dá 558,79 — o banco mostra 558,78');
  ok(Math.abs(282.27 + set.total - 558.78) <= 0.01,
    'a diferença pro banco fica dentro de UM CENTAVO por parcela final arredondada');
}
console.log('  ok');

// ── 2. Dedup: junta o que é a mesma compra ──────────────────────────────
console.log('── 2. dedup por instante ──');
{
  const c = deduplicar(REAIS);
  eq(c.length, 3, `5 linhas viram 3 compras (veio ${c.length})`);

  const prosed = c.find((x) => /PROSED/i.test(x.descricao));
  eq(prosed.valorParcela, 79.86, 'entre 79,86 e 79,87 fica a MENOR (é a que o banco mostra)');
  const payu = c.find((x) => /PayU/i.test(x.descricao));
  eq(payu.valorParcela, 139.99, 'entre 139,99 e 140,00 fica a menor');
}
console.log('  ok');

// ── 3. Dedup DE MENOS e DEMAIS: os dois erros caros ─────────────────────
console.log('── 3. o que NÃO pode ser fundido ──');
{
  // Mesmo valor e mesma loja, mas em SEGUNDOS diferentes: são duas compras.
  const duas = [
    { description: 'PADARIA', amount: -20, totalInstallments: 2, purchasedAt: '2026-08-03T10:00:00Z' },
    { description: 'PADARIA', amount: -20, totalInstallments: 2, purchasedAt: '2026-08-03T10:00:01Z' },
  ];
  eq(deduplicar(duas).length, 2, '1 segundo de diferença = duas compras (não funde)');

  // Mesmo instante, mas parcelamentos diferentes: compras diferentes.
  const difParcelas = [
    { description: 'LOJA', amount: -50, totalInstallments: 2, purchasedAt: '2026-08-03T10:00:00Z' },
    { description: 'LOJA', amount: -50, totalInstallments: 3, purchasedAt: '2026-08-03T10:00:00Z' },
  ];
  eq(deduplicar(difParcelas).length, 2, 'nº de parcelas diferente = compras diferentes');

  // Mesmo instante e parcelas, mas valores MUITO distantes: não é arredondamento.
  const difValor = [
    { description: 'LOJA A', amount: -50, totalInstallments: 2, purchasedAt: '2026-08-03T10:00:00Z' },
    { description: 'LOJA B', amount: -300, totalInstallments: 2, purchasedAt: '2026-08-03T10:00:00Z' },
  ];
  eq(deduplicar(difValor).length, 2, 'R$ 250 de diferença não é a duplicata da Polp');

  // 1 centavo NO MESMO instante É a duplicata.
  const umCentavo = [
    { description: 'X', amount: -10.00, totalInstallments: 2, purchasedAt: '2026-08-03T10:00:00Z' },
    { description: 'X LTDA', amount: -10.01, totalInstallments: 2, purchasedAt: '2026-08-03T10:00:00Z' },
  ];
  eq(deduplicar(umCentavo).length, 1, '1 centavo no mesmo segundo funde');
}
console.log('  ok');

// ── 4. A projeção NÃO confia em paidInstallments ────────────────────────
console.log('── 4. guiada por data, não por "pagas" ──');
{
  // O Chinoca vem "3 de 3 pagas" e MESMO ASSIM tem parcela em setembro —
  // é o campo que a Polp erra. Se a projeção olhasse `paidInstallments`,
  // essa parcela sumiria e a fatura sairia R$ 56,66 menor.
  const so = projetar([REAIS[0]], CARTAO, HOJE);
  eq(so.length, 1, 'parcelamento "todo pago" ainda projeta a parcela futura');
  eq(so[0].competencia, '2026-09', 'na competência certa');
  eq(so[0].parcela, 3, 'é a 3ª parcela');
}
console.log('  ok');

// ── 5. Nunca projeta no ciclo EM CURSO (contaria em dobro) ──────────────
console.log('── 5. só competência futura ──');
{
  const previstas = projetar(REAIS, CARTAO, HOJE);
  ok(previstas.every((p) => p.competencia > '2026-08'),
    'nada cai na competência atual — a compra do ciclo em curso já veio pelo extrato');
  eq(daCompetencia(previstas, '2026-08').total, 0, 'agosto não recebe projeção');
}
console.log('  ok');

// ── 6. NÃO projetar por cima do que já é transação ──────────────────────
//
// O risco mais caro daqui. Cartão que manda o marcador "N/M" na descrição
// (Nubank) tem as parcelas futuras REDISTRIBUÍDAS pelo sync e já lançadas como
// transação. Projetar em cima contaria a mesma parcela duas vezes e a fatura
// sairia MAIOR que a do banco — o inverso exato do bug de origem.
console.log('── 6. parcela que já é transação não é projetada ──');
{
  const previstas = projetar(REAIS, CARTAO, HOJE);
  const chinoca = previstas.find((p) => /CHINOCA/i.test(p.descricao));

  // O sync já lançou a 3/3 do Chinoca (cartão com marcador).
  const jaLancadas = [{ parcela_num: 3, parcela_total: 3, valor: 56.66 }];
  ok(jaEhTransacao(chinoca, jaLancadas), 'reconhece a parcela já lançada (1 centavo de folga)');

  // Mesma compra, parcela DIFERENTE: ainda tem de ser projetada.
  eq(jaEhTransacao(chinoca, [{ parcela_num: 2, parcela_total: 3, valor: 56.66 }]), false,
    'parcela 2 lançada não cobre a parcela 3');
  // Outro parcelamento com valor parecido não pode cancelar este.
  eq(jaEhTransacao(chinoca, [{ parcela_num: 3, parcela_total: 3, valor: 156.66 }]), false,
    'R$ 100 de diferença não é a mesma parcela');
  // Transação comum (sem parcela) nunca casa.
  eq(jaEhTransacao(chinoca, [{ valor: 56.66 }]), false,
    'transação sem marcador de parcela não cancela projeção');
  eq(jaEhTransacao(chinoca, [null, undefined]), false, 'lista com buracos não quebra');
}
console.log('  ok');

// ── 7. Bordas ────────────────────────────────────────────────────────────
console.log('── 7. bordas ──');
{
  eq(projetar([], CARTAO, HOJE).length, 0, 'lista vazia');
  eq(projetar(null, CARTAO, HOJE).length, 0, 'null não quebra');
  eq(projetar(REAIS, { dia_fechamento: null }, HOJE).length, 0,
    'cartão SEM dia de fechamento não projeta — sem ciclo não há competência confiável');
  eq(deduplicar([{ description: 'X', amount: -10, totalInstallments: 1, purchasedAt: '2026-08-03T10:00:00Z' }]).length, 0,
    'compra à vista (1x) não é parcelamento');
  eq(deduplicar([{ description: 'X', amount: -10, totalInstallments: 2 }]).length, 0,
    'sem data da compra não dá pra projetar — descarta');

  // Vira o ano.
  const fimDeAno = [{ description: 'NATAL', amount: -100, totalInstallments: 3,
    purchasedAt: '2026-11-20T10:00:00Z' }];
  const p = projetar(fimDeAno, CARTAO, '2026-11-25');
  eq(p.map((x) => x.competencia).join(','), '2027-01,2027-02', 'projeção atravessa a virada do ano');
}
console.log('  ok');

// ── Resultado ────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ parcelas previstas: todos os casos passaram');
