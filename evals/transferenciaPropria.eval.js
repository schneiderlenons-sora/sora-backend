// =============================================================================
// EVAL: "Movimentação entre suas contas?" — o par saída × entrada.
//
// services/transferenciaPropria.js. O que este eval trava:
//   1. a régua do PAR (como sempre foi): mesmo valor, contas diferentes, até 1
//      dia, R$ 50+, nunca cartão, par sem disputa, e o par em que as duas
//      pontas já estão fora não volta;
//   2. ⚠️ o MEIO-PAR (uma ponta marcada) continua sendo sugerido;
//   3. as janelas da TELA (relato do Breno, nov/2026): até 60 dias qualquer
//      par; de 60 dias a 1 ano SÓ o meio-par; mais de 1 ano, nada;
//   4. a confirmação do servidor (`confirmaPar`) aceita o par antigo.
//
// Rodar:  npm run eval:transferencia-propria
// =============================================================================
const { paresTransferencia, paresParaSugerir, confirmaPar } = require('../src/services/transferenciaPropria');

const falhas = [];
let total = 0;
const eq = (a, b, m) => { total++; const A = JSON.stringify(a), B = JSON.stringify(b); if (A !== B) falhas.push(`${m}\n     esperado ${B}\n     veio     ${A}`); };

// A régua de "já não conta" usada pelo app é a de resumoTransacoes; aqui basta a flag.
const ehT = (t) => t.transferencia === true;
const W = [
  { grupo_id: 'g', nome: 'Bradesco', tipo: 'Corrente' },
  { grupo_id: 'g', nome: 'PicPay', tipo: 'Corrente' },
  { grupo_id: 'g', nome: 'Nubank', tipo: 'Corrente' },
  { grupo_id: 'g', nome: 'MP Crédito', tipo: 'Crédito' },
  { grupo_id: 'h', nome: 'Bradesco', tipo: 'Corrente' },
  { grupo_id: 'h', nome: 'PicPay', tipo: 'Corrente' },
];
let seq = 0;
const tx = (tipo, valor, carteira, data, extra = {}) => ({ id: `t${++seq}`, grupo_id: 'g', tipo, valor, carteira_nome: carteira, data, transferencia: false, ...extra });
const ids = (pares) => pares.map((p) => `${p.saida.id}>${p.entrada.id}`);

console.log('── 1. a régua do par ──');
{
  const s = tx('Gasto', 3208, 'Bradesco', '2026-06-04'), e = tx('Recebimento', 3208, 'PicPay', '2026-06-04');
  eq(ids(paresTransferencia([s, e], W, ehT)), [`${s.id}>${e.id}`], 'saída e entrada iguais, contas diferentes, mesmo dia');
  eq(paresTransferencia([s, tx('Recebimento', 3208, 'PicPay', '2026-06-05')], W, ehT).length, 1, 'um dia de distância vale');
  eq(paresTransferencia([s, tx('Recebimento', 3208, 'PicPay', '2026-06-06')], W, ehT).length, 0, 'dois dias não vale');
  eq(paresTransferencia([s, tx('Recebimento', 3208.01, 'PicPay', '2026-06-04')], W, ehT).length, 0, 'valor diferente não vale');
  eq(paresTransferencia([s, tx('Recebimento', 3208, 'Bradesco', '2026-06-04')], W, ehT).length, 0, 'mesma conta não vale');
  eq(paresTransferencia([tx('Gasto', 49.99, 'Bradesco', '2026-06-04'), tx('Recebimento', 49.99, 'PicPay', '2026-06-04')], W, ehT).length, 0, 'abaixo de R$ 50 não sugere');
  eq(paresTransferencia([tx('Gasto', 900, 'Bradesco', '2026-06-04'), tx('Recebimento', 900, 'MP Crédito', '2026-06-04')], W, ehT).length, 0, 'cartão fica de fora');
  eq(paresTransferencia([tx('Gasto', 900, 'Bradesco', '2026-06-04'), tx('Recebimento', 900, 'Conta que não existe', '2026-06-04')], W, ehT).length, 0, 'conta que não existe fica de fora');
  const e1 = tx('Recebimento', 4049.86, 'PicPay', '2026-10-20'), e2 = tx('Recebimento', 4049.86, 'Nubank', '2026-10-20');
  eq(paresTransferencia([tx('Gasto', 4049.86, 'Bradesco', '2026-10-20'), e1, e2], W, ehT).length, 0, '⚠️ duas entradas iguais: disputa, não escolhe');
  eq(paresTransferencia([tx('Gasto', 700, 'Bradesco', '2026-10-20'), tx('Gasto', 700, 'Nubank', '2026-10-20'), tx('Recebimento', 700, 'PicPay', '2026-10-20')], W, ehT).length, 0, 'duas saídas iguais: disputa');
  eq(paresTransferencia([tx('Gasto', 800, 'Bradesco', '2026-06-04', { transferencia: true }), tx('Recebimento', 800, 'PicPay', '2026-06-04', { transferencia: true })], W, ehT).length, 0, 'as duas já fora: não volta');
  eq(paresTransferencia([tx('Gasto', 800, 'Bradesco', '2026-06-04'), { ...tx('Recebimento', 800, 'PicPay', '2026-06-04'), grupo_id: 'h' }], W, ehT).length, 0, 'grupos diferentes nunca formam par');
}

console.log('── 2. ⚠️ o meio-par (o caso do Breno) ──');
{
  const s = tx('Gasto', 2395.16, 'Bradesco', '2026-06-04'), e = tx('Recebimento', 2395.16, 'Nubank', '2026-06-04', { transferencia: true });
  eq(paresTransferencia([s, e], W, ehT).length, 1, 'saída solta + entrada já marcada → sugere');
  const s2 = tx('Gasto', 3200, 'PicPay', '2026-08-31', { transferencia: true }), e2 = tx('Recebimento', 3200, 'Bradesco', '2026-08-31');
  eq(paresTransferencia([s2, e2], W, ehT).length, 1, 'e o inverso: saída marcada + entrada solta');
}

console.log('── 3. as janelas da tela ──');
{
  const HOJE = '2026-11-25';
  const par = (data, marcadaUmaPonta) => {
    const s = tx('Gasto', 1000 + (++seq), 'Bradesco', data);
    const e = tx('Recebimento', s.valor, 'PicPay', data, { transferencia: !!marcadaUmaPonta });
    return [s, e];
  };
  const recenteSolto = par('2026-11-10', false);        // 15 dias, nenhuma ponta marcada
  const limiteSolto = par('2026-09-26', false);         // 60 dias exatos
  const velhoSolto = par('2026-09-25', false);          // 61 dias, nenhuma marcada
  const velhoMeio = par('2026-06-04', true);            // 174 dias, meio-par
  const umAnoMeio = par('2025-11-25', true);            // 365 dias, meio-par
  const maisDeAno = par('2025-11-24', true);            // 366 dias, meio-par
  // Fora de ordem de propósito: a tela tem de ordenar (o banco não garante).
  const todos = [...velhoMeio, ...recenteSolto, ...maisDeAno, ...limiteSolto, ...umAnoMeio, ...velhoSolto];
  const sug = paresParaSugerir(todos, W, ehT, { hoje: HOJE });
  const tem = (p) => sug.some((x) => x.saida.id === p[0].id);
  eq(tem(recenteSolto), true, 'até 60 dias: qualquer par (como sempre)');
  eq(tem(limiteSolto), true, '60 dias exatos ainda é a janela de qualquer par');
  eq(tem(velhoSolto), false, '⚠️ mais de 60 dias sem nenhuma ponta marcada NÃO sugere (é onde mora a coincidência)');
  eq(tem(velhoMeio), true, '⚠️ meio-par antigo agora sugere (o Breno de junho)');
  eq(tem(umAnoMeio), true, 'meio-par de 1 ano exato sugere');
  eq(tem(maisDeAno), false, 'mais de 1 ano: nada');
  eq(sug.map((p) => p.saida.data), [...sug.map((p) => p.saida.data)].sort().reverse(), 'do mais recente pro mais antigo');
  // Regressão: nos últimos 60 dias a tela sugere EXATAMENTE o que sugeria antes.
  const so60 = todos.filter((t) => t.data >= '2026-09-26');
  eq(paresParaSugerir(so60, W, ehT, { hoje: HOJE }).map((p) => p.saida.id).sort(),
    paresTransferencia(so60, W, ehT).map((p) => p.saida.id).sort(), '⚠️ dentro de 60 dias, igual à régua antiga');
}

console.log('── 4. o servidor confirma o par antigo ──');
{
  const s = { ...tx('Gasto', 6867, 'Bradesco', '2026-09-04'), grupo_id: 'g' };
  const e = { ...tx('Recebimento', 6867, 'PicPay', '2026-09-04', { transferencia: true }), grupo_id: 'g' };
  eq(confirmaPar(s, e, W, ehT), true, 'par de setembro (meio-par) é confirmado');
  eq(confirmaPar(e, s, W, ehT), false, 'saída e entrada trocadas não confirmam');
}

console.log(`\n${total - falhas.length}/${total} verificações passaram`);
if (falhas.length) { console.error('\n✗ FALHAS:\n  ' + falhas.join('\n  ')); process.exit(1); }
console.log('✓ eval:transferencia-propria ok');
