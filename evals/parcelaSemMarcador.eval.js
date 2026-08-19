// =============================================================================
// EVAL — parcela SEM marcador "N/M" (o banco manda todas na data da COMPRA)
//
// Existe um segundo jeito de o emissor mandar parcelamento. Medido na base: 8
// dos 29 cartões de Open Finance nunca chegam com `charge_identificator`/
// `charge_number` nas transações. Nesses o emissor não deixa de mandar as
// parcelas — manda TODAS de uma vez, cada uma como transação própria, todas
// datadas no dia da compra:
//
//   2026-06-20   56,66 · 56,66 · 56,67   CHINOCA        (3 parcelas)
//   2026-07-14  140,00 · 139,99          PayU *ADIDAS   (2 parcelas)
//   2026-08-03   79,86 ·  79,87          JIM.COM PROSED (2 parcelas)
//
// A fatura da COMPRA vinha inflada e as seguintes vazias:
//   fatura em aberto na Sora .... R$ 1.376,33
//   fatura no app do banco ...... R$ 1.596,17
//
// ⚠️ O AGRUPAMENTO SAI DE `occurrences[]`, NÃO DE HEURÍSTICA. O doc de
// `/credit-cards/{id}/installments` define: "occurrences: IDs das transações do
// cartão, ORDENADAS POR charge_identificator". O agregador já diz quais
// transações formam a compra e em que ordem.
//
// ⚠️ E `purchasedAt` NÃO EXISTE NA RESPOSTA — os campos documentados são só
// description, amount, totalInstallments, paidInstallments e occurrences.
// Casar a compra por `purchasedAt` (que vinha `undefined`) fazia NENHUM plano
// casar, e o sintoma era "sincronizei e a fatura não mudou".
// =============================================================================
const { redistribuirSemMarcador } = require('../src/services/polpCelcoinSync');
const { cicloPorCompetencia } = require('../src/services/cicloFatura');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

const CARTAO = { dia_fechamento: 8, dia_vencimento: 13 };
const HOJE = '2026-08-19';

// Transações como o banco as manda: todas na data da compra, sem marcador.
const tx = (id, descricao, valor, data) => ({
  externalId: id, ehGasto: true, valor, descricao, data,
  pago: true, parcelaNum: null, parcelaTotal: null,
});

const doBanco = () => [
  tx('chi-1', 'CHINOCA', 56.67, '2026-06-20T18:15:06Z'),
  tx('chi-2', 'CHINOCA', 56.66, '2026-06-20T18:15:07Z'),
  tx('chi-3', 'CHINOCA', 56.66, '2026-06-20T18:15:08Z'),
  tx('adi-1', 'PayU        *ADIDAS', 140.00, '2026-07-14T00:14:02+00:00'),
  tx('adi-2', 'PayU        *ADI', 139.99, '2026-07-14T00:14:02+00:00'),
  tx('pro-1', 'JIM.COM PROSED ES', 79.87, '2026-08-03T22:31:55Z'),
  tx('pro-2', 'JIM.COM PROSED ES', 79.86, '2026-08-03T22:31:56Z'),
];

// Payload de /installments: só os 5 campos que a API devolve de verdade.
const PLANOS = [
  { description: 'CHINOCA', amount: -56.67, totalInstallments: 3,
    paidInstallments: 3, occurrences: ['chi-1', 'chi-2', 'chi-3'] },
  { description: 'PayU *ADI', amount: -139.99, totalInstallments: 2,
    paidInstallments: 2, occurrences: ['adi-1', 'adi-2'] },
  { description: 'JIM.COM PROSED ES', amount: -79.86, totalInstallments: 2,
    paidInstallments: 2, occurrences: ['pro-1', 'pro-2'] },
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
  const mudadas = redistribuirSemMarcador(linhas, PLANOS, HOJE);
  eq(mudadas.length, 4, 'quatro parcelas saem da fatura da compra');

  const CICLO_SEM_PARCELAS = 1319.66;          // as compras normais do ciclo
  const parcelas = somaDoCiclo(linhas, '2026-09');
  eq(parcelas, 276.51, 'as três parcelas que caem na fatura em aberto');
  eq(Math.round((CICLO_SEM_PARCELAS + parcelas) * 100) / 100, 1596.17,
    'FATURA = 1.596,17, exatamente o app do banco');
}
console.log('  ok');

// ── 2. A ORDEM VEM DE `occurrences`, não de palpite ──────────────────────
//
// O centavo diferente é o arredondamento do banco. Qual parcela leva ele NÃO é
// coisa nossa de decidir: `occurrences` já vem ordenada por
// charge_identificator, então o índice É o número da parcela.
console.log('── 2. a ordem é a de occurrences ──');
{
  const linhas = doBanco();
  redistribuirSemMarcador(linhas, PLANOS, HOJE);
  const chinoca = ['chi-1', 'chi-2', 'chi-3'].map((id) => linhas.find((t) => t.externalId === id));
  eq(chinoca.map((t) => t.parcelaNum).join(''), '123', 'o índice em occurrences é o nº da parcela');
  eq(chinoca.map((t) => t.valor).join('|'), '56.67|56.66|56.66', 'e os valores seguem essa ordem');

  // Invertendo occurrences, a numeração inverte junto — prova que a fonte é ela.
  const outras = doBanco();
  const invertido = [{ ...PLANOS[0], occurrences: ['chi-3', 'chi-2', 'chi-1'] }];
  redistribuirSemMarcador(outras, invertido, HOJE);
  eq(outras.find((t) => t.externalId === 'chi-3').parcelaNum, 1, 'occurrences invertida inverte a parcela');
}
console.log('  ok');

// ── 3. Cada parcela na fatura CERTA ──────────────────────────────────────
console.log('── 3. cada parcela na sua fatura ──');
{
  const linhas = doBanco();
  redistribuirSemMarcador(linhas, PLANOS, HOJE);
  eq(somaDoCiclo(linhas, '2026-07'), 56.67, 'julho leva só a 1ª do Chinoca (antes levava as 3)');
  eq(somaDoCiclo(linhas, '2026-08'), 276.53, 'agosto leva uma de cada');
  const total = [7, 8, 9].reduce((s, m) => s + somaDoCiclo(linhas, `2026-0${m}`), 0);
  // 609,71 = a soma das 7 linhas que o banco mandou. O dinheiro só mudou de
  // fatura; não pode aparecer nem sumir centavo nenhum no caminho.
  eq(Math.round(total * 100) / 100, 609.71, 'e a SOMA das faturas não muda: nada some nem duplica');
}
console.log('  ok');

// ── 4. HISTÓRICO TRUNCADO: numerar pelo FIM ──────────────────────────────
//
// ⚠️ `paidInstallments` é o MAIOR charge_identificator observado, não a
// contagem — está no doc. Com o histórico truncado (só as parcelas 2 e 3 de 3
// visíveis) ele vem 3 com duas ocorrências. Numerar 1..N de frente jogaria a
// 2ª parcela na fatura da 1ª, que é o erro que isto existe pra evitar.
console.log('── 4. histórico truncado ──');
{
  const linhas = [
    tx('t-2', 'LOJA', 100, '2026-07-10T12:00:00Z'),
    tx('t-3', 'LOJA', 100, '2026-07-10T12:00:01Z'),
  ];
  const plano = [{ description: 'LOJA', amount: -100, totalInstallments: 3,
    paidInstallments: 3, occurrences: ['t-2', 't-3'] }];
  redistribuirSemMarcador(linhas, plano, HOJE);
  eq(linhas[0].parcelaNum, 2, 'a primeira ocorrência visível é a parcela 2');
  eq(linhas[1].parcelaNum, 3, 'e a seguinte é a 3');
  eq(String(linhas[1].data).slice(0, 7), '2026-08', 'a 3ª vai pro mês seguinte');
}
console.log('  ok');

// ── 5. O QUE NÃO PODE SER TOCADO ─────────────────────────────────────────
console.log('── 5. o que não é redistribuído ──');
{
  // Uma ocorrência só = compra normal (o emissor mandou só a 1ª parcela).
  // Quem cobre o futuro é a projeção de `parcelasPrevistas`.
  const uma = [tx('ali-1', 'MP*ALIEXPRESS', 347.52, '2026-04-25T02:25:53Z')];
  const plano = [{ description: 'MP*ALIEXPRESS', amount: -347.52, totalInstallments: 9,
    paidInstallments: 1, occurrences: ['ali-1'] }];
  eq(redistribuirSemMarcador(uma, plano, HOJE).length, 0, 'uma ocorrência só nunca é redistribuída');
  eq(uma[0].parcelaTotal, null, 'e não ganha marcador de parcela');

  // Transação que o sync não importou: sem o conjunto declarado, não age.
  const faltando = [tx('chi-1', 'CHINOCA', 56.67, '2026-06-20T18:15:06Z')];
  eq(redistribuirSemMarcador(faltando, PLANOS, HOJE).length, 0,
    'faltando transação do plano, não numera pela metade');

  // Já tem marcador → a redistribuição por "N/M" cuidou dela.
  const jaMarcada = doBanco().map((t) => (/CHINOCA/.test(t.descricao)
    ? { ...t, parcelaNum: 1, parcelaTotal: 3 } : t));
  eq(redistribuirSemMarcador(jaMarcada, [PLANOS[0]], HOJE).length, 0,
    'linha com marcador não é tocada de novo');

  // Crédito/estorno não é parcela de compra.
  const credito = doBanco().map((t) => (/CHINOCA/.test(t.descricao) ? { ...t, ehGasto: false } : t));
  eq(redistribuirSemMarcador(credito, [PLANOS[0]], HOJE).length, 0, 'crédito não é parcela');

  // Sem occurrences não há o que agrupar.
  const semOcor = [{ description: 'X', amount: -50, totalInstallments: 2, paidInstallments: 2 }];
  eq(redistribuirSemMarcador(doBanco(), semOcor, HOJE).length, 0, 'plano sem occurrences é ignorado');
}
console.log('  ok');

// ── 6. Bordas ────────────────────────────────────────────────────────────
console.log('── 6. bordas ──');
{
  eq(redistribuirSemMarcador(null, PLANOS, HOJE).length, 0, 'lista nula não quebra');
  eq(redistribuirSemMarcador([null, undefined], PLANOS, HOJE).length, 0, 'lista com buracos não quebra');
  eq(redistribuirSemMarcador(doBanco(), null, HOJE).length, 0, 'sem parcelamentos não quebra');
  eq(redistribuirSemMarcador(doBanco(), [], HOJE).length, 0, 'lista vazia não quebra');
  const lixo = [{ description: 'X', totalInstallments: 1, paidInstallments: 1,
    occurrences: ['chi-1', 'chi-2'] }];
  eq(redistribuirSemMarcador(doBanco(), lixo, HOJE).length, 0, 'total 1 não é parcelamento');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.log(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('✓ parcela sem marcador: todos os casos passaram');
