// =============================================================================
// EVAL das contas que se repetem no Sora Negócios (services/serieNegocio.js).
//
// Errar aqui não dá erro: dá uma projeção de caixa errada — semana faltando,
// mês dobrado, conta parada que volta sozinha — e é com ela que o dono decide.
//
// Rodar: npm run eval:serie-negocio
// =============================================================================
const { planejarSerie, ocorrencia } = require('../src/services/serieNegocio');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

const L = (extra) => ({
  id: 'l1', serie_id: 's1', empresa_id: 'e1', user_id: 'u1', tipo: 'entrada', categoria: 'servico',
  descricao: 'Contrato semanal', valor: 150000, contraparte: 'Cliente X', conta_id: 'c1',
  forma_pagamento: 'pix', status: 'pendente', vencimento: '2026-10-30', data: '2026-10-30',
  recorrente: true, recorrencia: 'semanal', serie_ate: null,
  transacao_id: null, origem: null, ...extra,
});
const datas = (rows) => rows.map((r) => r.vencimento);

// ── §1. Semanal: 13 semanas à frente ────────────────────────────────────────
console.log('§1 semanal');
{
  const r = planejarSerie([L()], '2026-10-30');
  eq(r.length, 13, '§1 gera 13 semanas (horizonte de 91 dias)');
  eq(r[0].vencimento, '2026-11-06', '§1 a primeira é 7 dias depois');
  eq(r[12].vencimento, '2027-01-29', '§1 a última cai no limite do horizonte');
  ok(r.every((x) => x.status === 'pendente' && x.pago_em === null), '§1 todas em aberto');
  ok(r.every((x) => x.data === x.vencimento), '§1 a competência é o vencimento');
  eq(r[0].valor, 150000, '§1 herda o valor');
  eq(r[0].contraparte, 'Cliente X', '§1 herda o cliente');
  eq(r[0].conta_id, 'c1', '§1 herda a conta');
  eq(r[0].serie_id, 's1', '§1 mesma série');
  ok(!('transacao_id' in r[0]) && !('origem' in r[0]) && !('id' in r[0]), '§1 não herda vínculo com o banco nem id');
}
console.log('  ok');

// ── §2. Mensal: o dia do mês vem da PRIMEIRA ocorrência ─────────────────────
console.log('§2 mensal e fim de mês');
{
  eq(ocorrencia('2026-01-31', 'mensal', 1), '2026-02-28', '§2 31/jan → 28/fev');
  eq(ocorrencia('2026-01-31', 'mensal', 2), '2026-03-31', '§2 e volta a 31 em março');
  eq(ocorrencia('2026-01-31', 'mensal', 3), '2026-04-30', '§2 30 em abril');
  eq(ocorrencia('2028-02-29', 'anual', 1), '2029-02-28', '§2 anual em 29/fev vira 28/fev');
  eq(ocorrencia('2026-10-30', 'semanal', 2), '2026-11-13', '§2 semanal soma 14 dias');
  // Série cuja última ocorrência caiu no dia 28 (fevereiro) continua no 31.
  const linhas = [
    L({ id: 'a', recorrencia: 'mensal', vencimento: '2027-01-31', data: '2027-01-31' }),
    L({ id: 'b', recorrencia: 'mensal', vencimento: '2027-02-28', data: '2027-02-28' }),
  ];
  const r = planejarSerie(linhas, '2027-02-10');
  eq(r[0].vencimento, '2027-03-31', '§2 depois de fevereiro, volta ao 31');
  eq(datas(r).length, 5, '§2 mensal: até ~6 meses à frente');
}
console.log('  ok');

// ── §3. Até quando ──────────────────────────────────────────────────────────
console.log('§3 fim da série');
{
  const r = planejarSerie([L({ serie_ate: '2026-11-20' })], '2026-10-30');
  eq(datas(r), ['2026-11-06', '2026-11-13', '2026-11-20'], '§3 para no "repetir até" (inclusive)');
  eq(planejarSerie([L({ serie_ate: '2026-10-30' })], '2026-10-30').length, 0, '§3 fim no próprio dia: nada mais');
}
console.log('  ok');

// ── §4. Só DEPOIS da última; nunca recria o que foi apagado ─────────────────
console.log('§4 sem recriar apagadas');
{
  // Semanas 06/11 e 20/11 existem; a de 13/11 (feriado) foi APAGADA.
  const linhas = [L(), L({ id: 'b', vencimento: '2026-11-06', data: '2026-11-06' }),
    L({ id: 'c', vencimento: '2026-11-20', data: '2026-11-20' })];
  const r = planejarSerie(linhas, '2026-10-30');
  ok(!datas(r).includes('2026-11-13'), '§4 a semana apagada no meio não volta');
  eq(r[0].vencimento, '2026-11-27', '§4 continua depois da última');
  // Idempotente: rodar de novo com o que foi gerado não gera nada.
  eq(planejarSerie([...linhas, ...r], '2026-10-30').length, 0, '§4 segunda passada não duplica');
  // E anda com o tempo: um mês depois, completa o novo horizonte.
  const depois = planejarSerie([...linhas, ...r], '2026-11-30');
  ok(depois.length > 0 && depois[0].vencimento > r[r.length - 1].vencimento, '§4 o job estende o horizonte');
}
console.log('  ok');

// ── §5. O modelo é a ocorrência MAIS RECENTE ────────────────────────────────
console.log('§5 modelo');
{
  const linhas = [L(), L({ id: 'b', vencimento: '2026-11-06', data: '2026-11-06', valor: 175000 })];
  eq(planejarSerie(linhas, '2026-10-30')[0].valor, 175000, '§5 o reajuste da última vale pras próximas');
  // A primeira já paga (sem vencimento): ancora na data.
  const paga = L({ status: 'pago', vencimento: null, data: '2026-10-30', pago_em: '2026-10-30' });
  eq(planejarSerie([paga], '2026-10-30')[0].vencimento, '2026-11-06', '§5 paga sem vencimento ancora na data');
}
console.log('  ok');

// ── §6. O que NÃO gera ──────────────────────────────────────────────────────
console.log('§6 não gera');
{
  eq(planejarSerie([L({ recorrente: false })], '2026-10-30').length, 0, '§6 série parada');
  eq(planejarSerie([L({ recorrencia: 'diaria' })], '2026-10-30').length, 0, '§6 recorrência desconhecida');
  eq(planejarSerie([L({ recorrencia: null })], '2026-10-30').length, 0, '§6 sem recorrência');
  eq(planejarSerie([L({ serie_id: null })], '2026-10-30').length, 0, '§6 sem série');
  eq(planejarSerie([], '2026-10-30').length, 0, '§6 lista vazia');
  // Série antiga (última ocorrência há meses): não gera um passado inteiro.
  const velha = planejarSerie([L({ vencimento: '2025-01-03', data: '2025-01-03' })], '2026-10-30');
  ok(velha.length > 0 && velha.every((x) => x.vencimento >= '2026-09-29'), '§6 série esquecida não gera passado além de 31 dias');
  eq(velha[0].vencimento, '2026-10-02', '§6 retoma na primeira data dentro da janela');
}
console.log('  ok');

if (falhas.length) {
  console.error(`\n✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('\n✓ contas que se repetem: todos os casos passaram');
