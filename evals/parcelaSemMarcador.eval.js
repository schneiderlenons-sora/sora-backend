// =============================================================================
// EVAL — parcela SEM marcador "N/M" (o banco manda todas na data da COMPRA)
//
// Existe um segundo jeito de o emissor mandar parcelamento, e ele estava sem
// tratamento. Medido na base: 8 dos 29 cartões de Open Finance NUNCA recebem
// `charge_identificator`/`charge_number`. Nesses, o banco não deixa de mandar
// as parcelas — manda TODAS de uma vez, cada uma como transação própria, todas
// datadas no dia da compra, com centavo diferente numa delas.
//
// O CASO REAL (Mercado Pago, 87 transações, ZERO com marcador):
//   fatura em aberto na Sora .... R$ 1.376,33
//   fatura no app do banco ...... R$ 1.596,17
//   diferença ................... R$   219,84  = 2ª do Adidas + 2ª do Prosed
//
// A fatura da COMPRA vinha inflada e as seguintes vazias. Redistribuindo, as
// duas pontas se resolvem de uma vez.
// =============================================================================
const { redistribuirSemMarcador } = require('../src/services/polpCelcoinSync');
const { projetar, daCompetencia, jaEhTransacao } = require('../src/services/parcelasPrevistas');
const { cicloPorCompetencia } = require('../src/services/cicloFatura');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

const CARTAO = { dia_fechamento: 8, dia_vencimento: 13 };
const HOJE = '2026-08-19';

// Payload REAL de /installments do cartão.
const PARCELAMENTOS = [
  { description: 'CHINOCA', amount: -56.67, totalInstallments: 3, paidInstallments: 3,
    purchasedAt: '2026-06-20T18:15:06.000000Z', occurrences: ['a', 'b', 'c'] },
  { description: 'JIM.COM PROSED ES', amount: -79.86, totalInstallments: 2, paidInstallments: 1,
    purchasedAt: '2026-08-03T22:31:55.000000Z', occurrences: ['d'] },
  { description: 'PayU *ADI', amount: -139.99, totalInstallments: 2, paidInstallments: 1,
    purchasedAt: '2026-07-14T03:14:02.000000Z', occurrences: ['g'] },
];

const tx = (descricao, valor, data) => ({
  externalId: `of-${descricao}-${valor}`, ehGasto: true, valor, descricao, data,
  pago: true, parcelaNum: null, parcelaTotal: null,
});

// As transações REAIS, como o banco as manda: todas na data da compra.
const doBanco = () => [
  tx('CHINOCA', 56.66, '2026-06-20T18:15:06Z'),
  tx('CHINOCA', 56.66, '2026-06-20T18:15:07Z'),
  tx('CHINOCA', 56.67, '2026-06-20T18:15:08Z'),
  // ⚠️ TIMESTAMPS REAIS: a transação vem 3h ANTES do `purchasedAt` do plano
  // (00:14Z = 13/07 21h em São Paulo, contra 14/07 no plano). Casar pelo DIA do
  // plano deixava esta compra de fora — ver §2B.
  tx('PayU        *ADIDAS', 140.00, '2026-07-14T00:14:02+00:00'),
  tx('PayU        *ADI', 139.99, '2026-07-14T00:14:02+00:00'),
  tx('JIM.COM PROSED ES', 79.86, '2026-08-03T22:31:55Z'),
  tx('JIM.COM PROSED ES', 79.87, '2026-08-03T22:31:56Z'),
];

const somaDoCiclo = (linhas, competencia) => {
  const c = cicloPorCompetencia(CARTAO, competencia);
  const d = (t) => String(t.data).slice(0, 10);
  return Math.round(linhas.filter((t) => d(t) >= c.ini && d(t) < c.fimExcl)
    .reduce((s, t) => s + t.valor, 0) * 100) / 100;
};

// ── 1. O NÚMERO DO CLIENTE ───────────────────────────────────────────────
console.log('── 1. a fatura em aberto fecha com o banco ──');
{
  const linhas = doBanco();
  redistribuirSemMarcador(linhas, PARCELAMENTOS, HOJE);
  const CICLO_SEM_PARCELAS = 1319.66;          // as compras normais do ciclo
  const parcelas = somaDoCiclo(linhas, '2026-09');
  eq(parcelas, 276.51, 'as três parcelas que caem na fatura em aberto');
  eq(Math.round((CICLO_SEM_PARCELAS + parcelas) * 100) / 100, 1596.17,
    'FATURA = 1.596,17, exatamente o app do banco');
}
console.log('  ok');

// ── 2. A ordem do centavo NÃO é chute ────────────────────────────────────
//
// O centavo a mais vai na PRIMEIRA parcela. As duas ordens foram medidas
// contra a fatura publicada: crescente dá 1.596,20 (3 centavos a mais),
// decrescente dá 1.596,17. `parcelasPrevistas` documenta o contrário porque lá
// a parcela é CALCULADA do valor nominal; aqui os valores vêm prontos do banco
// e o que importa é só a ordem em que são atribuídos.
console.log('── 2. o centavo a mais fica na 1ª parcela ──');
{
  const linhas = doBanco();
  redistribuirSemMarcador(linhas, PARCELAMENTOS, HOJE);
  const chinoca = linhas.filter((t) => /CHINOCA/.test(t.descricao))
    .sort((a, b) => a.parcelaNum - b.parcelaNum);
  eq(chinoca.map((t) => t.valor).join('|'), '56.67|56.66|56.66', 'a de 56,67 é a 1ª, não a 3ª');
  eq(chinoca[0].parcelaTotal, 3, 'e todas sabem que são 3');
}
console.log('  ok');

// ── 2B. O DIA DAS DUAS FONTES NÃO BATE ───────────────────────────────────
//
// Compra perto da meia-noite: a transação veio `2026-07-14T00:14:02+00:00`
// (13/07 às 21h em São Paulo) e o plano veio `2026-07-14T03:14:02Z` (14/07 às
// 00h14) — 3 horas de diferença, exatamente o fuso. Enquanto o agrupamento era
// ancorado no `purchasedAt` do plano, esta compra ficava de fora e a 2ª parcela
// seguia na fatura errada. O agrupamento é ancorado na TRANSAÇÃO.
console.log('── 2B. dia divergente entre transação e plano ──');
{
  const linhas = doBanco();
  redistribuirSemMarcador(linhas, PARCELAMENTOS, HOJE);
  const adidas = linhas.filter((t) => /ADI/.test(t.descricao)).sort((a, b) => a.parcelaNum - b.parcelaNum);
  eq(adidas.length, 2, 'as duas do Adidas foram encontradas');
  eq(adidas[0].parcelaTotal, 2, 'e reconhecidas como parcelamento em 2x');
  eq(String(adidas[1].data).slice(0, 10), '2026-08-13', 'a 2ª foi pra fatura seguinte');

  // Mas o desencontro tem limite: plano de semanas atrás não agrupa.
  const outroDia = [tx('X', 100, '2026-07-01T12:00:00Z'), tx('X', 100, '2026-07-01T12:00:01Z')];
  const planoLonge = [{ description: 'X', amount: -100, totalInstallments: 2,
    purchasedAt: '2026-07-20T12:00:00.000000Z', occurrences: ['a'] }];
  eq(redistribuirSemMarcador(outroDia, planoLonge, HOJE).length, 0,
    '19 dias de diferença não é desencontro de fuso: não agrupa');
}
console.log('  ok');

// ── 3. Cada parcela na fatura CERTA ──────────────────────────────────────
console.log('── 3. cada parcela na sua fatura ──');
{
  const linhas = doBanco();
  redistribuirSemMarcador(linhas, PARCELAMENTOS, HOJE);
  // Chinoca (3x, comprado 20/06): uma em cada fatura, nunca três na primeira.
  eq(somaDoCiclo(linhas, '2026-07'), 56.67, 'julho leva só a 1ª do Chinoca (antes levava as 3)');
  // Agosto: 2ª do Chinoca + 1ª do Adidas + 1ª do Prosed.
  // 2ª do Chinoca 56,66 + 1ª do Adidas 140,00 + 1ª do Prosed 79,87.
  eq(somaDoCiclo(linhas, '2026-08'), 276.53, 'agosto leva uma de cada');
  const total = [7, 8, 9].reduce((s, m) => s + somaDoCiclo(linhas, `2026-0${m}`), 0);
  // 609,71 = a soma das 7 linhas que o banco mandou. O dinheiro só mudou de
  // fatura; não pode aparecer nem sumir centavo nenhum no caminho.
  eq(Math.round(total * 100) / 100, 609.71, 'e a SOMA das faturas não muda: nada some nem duplica');
}
console.log('  ok');

// ── 4. O QUE NÃO PODE VIRAR PARCELAMENTO ─────────────────────────────────
console.log('── 4. o que não pode ser agrupado ──');
{
  // Uma linha sozinha é a compra normal (Nubank/Itaú mandam só a 1ª) — quem
  // cobre o futuro é a projeção. Agrupar aqui viraria compra à vista em 9x.
  const uma = [tx('MP*ALIEXPRESS', 347.52, '2026-04-25T02:25:53Z')];
  const plano = [{ description: 'MP*ALIEXPRESS', amount: -347.52, totalInstallments: 9,
    purchasedAt: '2026-04-25T02:25:53.000000Z', occurrences: ['a'] }];
  eq(redistribuirSemMarcador(uma, plano, HOJE).length, 0, 'uma linha sozinha nunca é redistribuída');
  eq(uma[0].parcelaTotal, null, 'e não ganha marcador de parcela');

  // Sem plano no /installments não há agrupamento: dois cafés de R$ 20 no
  // mesmo dia não podem virar um parcelamento em 2x.
  const cafes = [tx('CAFETERIA', 20, '2026-08-10T09:00:00Z'), tx('CAFETERIA', 20, '2026-08-10T15:00:00Z')];
  eq(redistribuirSemMarcador(cafes, [], HOJE).length, 0, 'sem plano do banco, nada é agrupado');
  eq(redistribuirSemMarcador(cafes, PARCELAMENTOS, HOJE).length, 0, 'e plano de OUTRA compra não serve');

  // Mais irmãs que parcelas = agrupamento suspeito: não mexe.
  const demais = [tx('X', 50, '2026-08-10T09:00:00Z'), tx('X', 50, '2026-08-10T10:00:00Z'),
    tx('X', 50, '2026-08-10T11:00:00Z')];
  const plano2 = [{ description: 'X', amount: -50, totalInstallments: 2,
    purchasedAt: '2026-08-10T09:00:00.000000Z', occurrences: ['a'] }];
  eq(redistribuirSemMarcador(demais, plano2, HOJE).length, 0, '3 linhas pra um plano de 2x não é redistribuído');

  // Crédito/estorno nunca entra.
  const credito = [{ ...tx('CHINOCA', 56.66, '2026-06-20T18:15:06Z'), ehGasto: false },
    { ...tx('CHINOCA', 56.67, '2026-06-20T18:15:08Z'), ehGasto: false }];
  eq(redistribuirSemMarcador(credito, PARCELAMENTOS, HOJE).length, 0, 'crédito não é parcela de compra');

  // Quem JÁ tem marcador é da outra rota (redistribuição por "N/M").
  const jaMarcada = [{ ...tx('CHINOCA', 56.66, '2026-06-20T18:15:06Z'), parcelaTotal: 3, parcelaNum: 1 },
    { ...tx('CHINOCA', 56.67, '2026-06-20T18:15:08Z'), parcelaTotal: 3, parcelaNum: 3 }];
  eq(redistribuirSemMarcador(jaMarcada, PARCELAMENTOS, HOJE).length, 0, 'linha com marcador não é tocada de novo');
}
console.log('  ok');

// ── 4B. CONJUNTO INCOMPLETO não é redistribuído ──────────────────────────
//
// A janela do sync é de 90 dias, então parcelamento antigo pode aparecer pela
// METADE. Com 2 de 3 irmãs visíveis não dá pra saber se são a 1ª e a 2ª ou a
// 2ª e a 3ª — numerar no chute jogaria a parcela na fatura errada, que é
// exatamente o bug que isto veio consertar.
console.log('── 4B. conjunto incompleto ──');
{
  const duasDeTres = [
    tx('CHINOCA', 56.66, '2026-06-20T18:15:06Z'),
    tx('CHINOCA', 56.67, '2026-06-20T18:15:08Z'),
  ];
  eq(redistribuirSemMarcador(duasDeTres, PARCELAMENTOS, HOJE).length, 0,
    '2 irmãs pra um plano de 3x: não numera no chute');
  eq(duasDeTres[0].parcelaTotal, null, 'e nenhuma ganha marcador');

  // O conjunto completo do MESMO plano continua funcionando.
  const tres = [
    tx('CHINOCA', 56.66, '2026-06-20T18:15:06Z'),
    tx('CHINOCA', 56.66, '2026-06-20T18:15:07Z'),
    tx('CHINOCA', 56.67, '2026-06-20T18:15:08Z'),
  ];
  eq(redistribuirSemMarcador(tres, PARCELAMENTOS, HOJE).length, 2, 'as 3 completas redistribuem 2');
}
console.log('  ok');

// ── 5. Redistribuiu → a projeção NÃO pode projetar por cima ──────────────
//
// O risco caro: se a parcela virou transação E for projetada, a fatura sai
// MAIOR que a do banco — o inverso exato do bug de origem.
console.log('── 5. sem contagem em dobro com a projeção ──');
{
  const linhas = doBanco();
  redistribuirSemMarcador(linhas, PARCELAMENTOS, HOJE);
  const sobra = projetar(PARCELAMENTOS, CARTAO, HOJE).filter((l) => !jaEhTransacao(l, linhas, CARTAO));
  eq(daCompetencia(sobra, '2026-09').total, 0, 'nada sobra pra projetar: as parcelas já são transações');
}
console.log('  ok');

// ── 6. Bordas ────────────────────────────────────────────────────────────
console.log('── 6. bordas ──');
{
  eq(redistribuirSemMarcador(null, PARCELAMENTOS, HOJE).length, 0, 'lista nula não quebra');
  eq(redistribuirSemMarcador([null, undefined], PARCELAMENTOS, HOJE).length, 0, 'lista com buracos não quebra');
  eq(redistribuirSemMarcador(doBanco(), null, HOJE).length, 0, 'sem parcelamentos não quebra');
  const semData = [tx('CHINOCA', 56.66, 'nao-e-data'), tx('CHINOCA', 56.67, 'nao-e-data')];
  eq(redistribuirSemMarcador(semData, PARCELAMENTOS, HOJE).length, 0, 'data inválida não vira parcela');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.log(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('✓ parcela sem marcador: todos os casos passaram');
