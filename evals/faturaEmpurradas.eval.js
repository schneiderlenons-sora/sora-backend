// =============================================================================
// EVAL: O QUE O EMISSOR EMPURROU PRA FATURA SEGUINTE.
//
// RELATO (set/2026, cartão do dono, Mercado Pago): app do banco R$ 472,66,
// painel R$ 4.091,58 — "não tenho nem limite pra isso". E, junto: "se paguei a
// fatura fechada, deveria pular pra próxima com o valor certo".
//
// A causa NÃO era cálculo: era a fronteira do ciclo. O banco não fatura pela
// data da compra, e sim pela data em que ELE lança (`bill_post_date`). Duas
// compras do dia do fechamento ficaram de fora da fatura de setembro:
//
//   03/09 FACEBK 117,60 · post_date 2026-09-08  → entrou em setembro
//   07/09 ELÓI     5,49 · post_date 2026-09-08  → entrou
//   08/09 IFOOD   41,14 · post_date VAZIO       → o banco jogou pra outubro
//   08/09 APPLE    5,00 · post_date VAZIO       → idem
//
// Sem as duas, setembro soma 4.018,54 = exatamente o que foi pago
// (2.854,70 + 1.163,84) → fatura QUITADA, e a tela passa a pular sozinha.
// Outubro fica 426,52 + 46,14 = 472,66, o número do app do banco, ao centavo.
//
// ⚠️ ESTE ARQUIVO GUARDA OS TRÊS DEFEITOS QUE A PRIMEIRA VERSÃO TINHA, cada um
// achado medindo na base antes de subir. Os três moviam dinheiro:
//   §3 — a linha SUMIA das duas faturas (janela deslizante mudava o relógio);
//   §4 — a fatura de novembro DOBRAVA (herança de "35 dias" cruzava 2 ciclos);
//   §5 — fatura FUTURA ganhava valor do nada (ciclo aberto não empurra nada).
//
// Rodar:  npm run eval:fatura-empurradas
// =============================================================================
const { separarEmpurradas } = require('../src/services/faturaRollover');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };
const eq = (a, b, msg) => ok(a === b, `${msg} (esperado ${b}, veio ${a})`);

const g = (data, valor, post) => ({
  data: `${data}T12:00:00.000Z`, valor, tipo: 'Gasto',
  categoria: 'Compras', transferencia: false, of_bill_post_date: post || null,
});
const soma = (arr) => Math.round(arr.reduce((s, t) => s + t.valor, 0) * 100) / 100;

// O ciclo de setembro do cartão do relato: 09/08 → 08/09 (fimExcl 09/09).
const INI = '2026-08-09', FIM_EXCL = '2026-09-09';
const CICLO_SET = [
  g('2026-08-20', 56.66, null),          // linha antiga, sem o campo (histórico)
  g('2026-09-03', 117.60, '2026-09-08'),
  g('2026-09-07', 5.49, '2026-09-08'),
  g('2026-09-08', 41.14, null),          // iFood  → o banco empurrou
  g('2026-09-08', 5.00, null),           // Apple  → idem
];

console.log('── 1. o caso do relato ──');
{
  const { fica, sai } = separarEmpurradas(CICLO_SET, INI, FIM_EXCL, '2026-09-08');
  eq(sai.length, 2, 'duas linhas saem da fatura fechada');
  eq(soma(sai), 46.14, 'e somam exatamente os R$ 46,14 que o banco cobrou depois');
  eq(soma(fica), 179.75, 'o resto da fatura fica intacto');
}
console.log('  ok');

console.log('── 2. linha antiga sem o campo NÃO se move ──');
{
  // ⚠️ O corte é `>= maiorPost`, não "sem post_date". O histórico anterior à
  // coleta do campo é quase todo vazio — mover tudo isso reescreveria faturas
  // antigas inteiras.
  const { sai } = separarEmpurradas(CICLO_SET, INI, FIM_EXCL, '2026-09-08');
  ok(!sai.some((t) => t.valor === 56.66), 'a compra de 20/08 sem post_date fica onde está');
}
console.log('  ok');

console.log('── 3. vazio VELHO não é "ainda não faturada" ──');
{
  // O sync grava `bill_post_date` UMA VEZ e nunca reescreve a linha. Então a
  // compra do dia do fechamento do mês PASSADO ficou vazia pra sempre — mas ela
  // já foi cobrada há um ciclo. Quem denuncia isso é o relógio do EMISSOR.
  //
  // ⚠️ DEFEITO REAL QUE ISTO TRAVA: com o relógio saindo da janela deslizante,
  // agosto e setembro julgavam a MESMA linha de formas opostas — agosto a
  // empurrava, setembro não a herdava, e R$ 5,00 sumiam das duas faturas.
  const cicloAgo = [
    g('2026-08-05', 117.51, '2026-08-08'),
    g('2026-08-08', 5.00, null),   // Apple do mês anterior
  ];
  const comRelogioVelho = separarEmpurradas(cicloAgo, '2026-07-09', '2026-08-09', '2026-08-08');
  eq(comRelogioVelho.sai.length, 1, 'no dia, o vazio ainda significa "não faturada"');

  const comRelogioNovo = separarEmpurradas(cicloAgo, '2026-07-09', '2026-08-09', '2026-09-08');
  eq(comRelogioNovo.sai.length, 0, '⚠️ um ciclo depois, o mesmo vazio é só resíduo do import');
}
console.log('  ok');

console.log('── 4. sem referência, nada se move ──');
{
  // Nenhuma linha do trecho tem post_date → não dá pra afirmar nada. É o caso
  // da maior parte do histórico E de todo ciclo ainda ABERTO.
  const semPost = [g('2026-09-05', 10, null), g('2026-09-08', 20, null)];
  const { fica, sai } = separarEmpurradas(semPost, INI, FIM_EXCL, '2026-09-08');
  eq(sai.length, 0, 'sem post_date nenhum no trecho, ninguém é empurrado');
  eq(fica.length, 2, 'e tudo continua na fatura');
}
console.log('  ok');

console.log('── 5. simetria: o que sai de um lado entra do outro ──');
{
  // ⚠️ É a trava contra dinheiro evaporar. As duas metades do `somaFaturaCiclo`
  // chamam ESTA função com o MESMO `ultimoPost` — se um lado usar um relógio e
  // o outro usar outro, a linha some das duas faturas (foi o §3).
  const RELOGIO = '2026-09-08';
  const { sai } = separarEmpurradas(CICLO_SET, INI, FIM_EXCL, RELOGIO);
  const herdadas = separarEmpurradas(CICLO_SET, INI, FIM_EXCL, RELOGIO).sai;
  eq(soma(herdadas), soma(sai), 'a fatura seguinte herda EXATAMENTE o que a anterior largou');
}
console.log('  ok');

console.log('── 6. bordas ──');
{
  eq(separarEmpurradas(null, INI, FIM_EXCL, null).sai.length, 0, 'lista nula não quebra');
  eq(separarEmpurradas([], INI, FIM_EXCL, '2026-09-08').sai.length, 0, 'lista vazia não quebra');
  // Sem relógio conhecido (cartão que nunca recebeu post_date), a regra do vazio
  // velho não pode disparar sozinha — some quem for depois do maiorPost.
  const r = separarEmpurradas(CICLO_SET, INI, FIM_EXCL, null);
  eq(r.sai.length, 2, 'sem relógio, vale só o corte pelo maiorPost do trecho');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ empurradas pra fatura seguinte: todos os casos passaram');
