// =============================================================================
// eval:abatimento-ciclo — pagamentos seguem a ORDEM DO BANCO na fatura que
// fechou e ainda não foi publicada (services/faturaVista → abatimentosDoCiclo).
//
// RELATO (dono, nov/2026): Mercado Pago fechou em R$ 1.872,06 no banco e
// R$ 5.771,63 na Sora. O MP deixa abater a fatura em curso e a fecha LÍQUIDA.
// Números reais do cartão, ao centavo.
// =============================================================================
const assert = require('assert');
const { abatimentosDoCiclo, instituicaoEhMercadoPago, cent } = require('../src/services/faturaVista');

let ok = 0, falhou = 0;
function caso(nome, fn) { try { fn(); ok++; console.log('  ✓', nome); } catch (e) { falhou++; console.log('  ✗', nome, '—', e.message); } }

const pagamentos = [
  { valor: 600, data: '2026-10-01' },      // abatimento da fatura de OUTUBRO (antes do fech. 08/10)
  { valor: 500, data: '2026-10-03' },
  { valor: 2792.67, data: '2026-10-09' },  // paga outubro (publicada: 2.792,67)
  { valor: 2899.57, data: '2026-10-24' },  // abate NOVEMBRO
  { valor: 500, data: '2026-11-07' },
  { valor: 500, data: '2026-11-08' },      // 21h06 em SP — antes do fechamento
];
const nov = { totalAnterior: 2792.67, fechAnterior: '2026-10-08', fimCiclo: '2026-11-08', pagamentos };

console.log('\n§1 o caso do relato');
caso('novembro: abatido 3.899,57, nada pago depois', () => {
  assert.deepStrictEqual(abatimentosDoCiclo(nov), { abatido: 3899.57, pagoDepois: 0 });
});
caso('5.771,63 − abatido = 1.872,06 (o número do banco)', () => {
  assert.strictEqual(cent(5771.63 - abatimentosDoCiclo(nov).abatido), 1872.06);
});
caso('pagamento ANTES do fechamento da anterior não entra (já está no total publicado)', () => {
  const r = abatimentosDoCiclo({ ...nov, pagamentos: [{ valor: 600, data: '2026-10-01' }, { valor: 500, data: '2026-10-08' }] });
  assert.deepStrictEqual(r, { abatido: 0, pagoDepois: 0 });
});

caso('pago NO DIA do fechamento da anterior já está no total publicado (nem com sobra)', () => {
  const r = abatimentosDoCiclo({ ...nov, totalAnterior: 0, pagamentos: [{ valor: 100, data: '2026-10-08' }] });
  assert.deepStrictEqual(r, { abatido: 0, pagoDepois: 0 });
});
console.log('\n§2 a ordem importa');
caso('primeiro quita a anterior: pagamento menor que ela não abate nada', () => {
  const r = abatimentosDoCiclo({ ...nov, pagamentos: [{ valor: 1000, data: '2026-10-10' }] });
  assert.deepStrictEqual(r, { abatido: 0, pagoDepois: 0 });
});
caso('pagamento que passa da anterior: só a SOBRA abate', () => {
  const r = abatimentosDoCiclo({ ...nov, pagamentos: [{ valor: 3000, data: '2026-10-10' }] });
  assert.deepStrictEqual(r, { abatido: 207.33, pagoDepois: 0 });
});
caso('depois do fechamento do ciclo é PAGAMENTO, não abatimento', () => {
  const r = abatimentosDoCiclo({ ...nov, pagamentos: [{ valor: 2792.67, data: '2026-10-09' }, { valor: 1872.06, data: '2026-11-12' }] });
  assert.deepStrictEqual(r, { abatido: 0, pagoDepois: 1872.06 });
});
caso('fora de ordem na entrada: a função ordena pela data', () => {
  const r = abatimentosDoCiclo({ ...nov, pagamentos: [...pagamentos].reverse() });
  assert.deepStrictEqual(r, { abatido: 3899.57, pagoDepois: 0 });
});
caso('ordem invertida com pagamento depois do fechamento: a anterior é quitada pelo MAIS ANTIGO', () => {
  const r = abatimentosDoCiclo({ ...nov, pagamentos: [{ valor: 1872.06, data: '2026-11-12' }, { valor: 2792.67, data: '2026-10-09' }] });
  assert.deepStrictEqual(r, { abatido: 0, pagoDepois: 1872.06 });
});
caso('o dia do fechamento ainda é abatimento', () => {
  const r = abatimentosDoCiclo({ ...nov, pagamentos: [{ valor: 2792.67, data: '2026-10-09' }, { valor: 10, data: '2026-11-08' }] });
  assert.deepStrictEqual(r, { abatido: 10, pagoDepois: 0 });
});

console.log('\n§3 conferido no mês publicado (outubro)');
caso('4.846,53 − abatido fica a 46,14 do publicado (a compra que muda de ciclo)', () => {
  const r = abatimentosDoCiclo({
    totalAnterior: 1163.84, fechAnterior: '2026-09-08', fimCiclo: '2026-10-08',
    pagamentos: [
      { valor: 1163.84, data: '2026-09-09' }, { valor: 500, data: '2026-09-27' },
      { valor: 500, data: '2026-09-29' }, { valor: 600, data: '2026-10-01' }, { valor: 500, data: '2026-10-03' },
    ],
  });
  assert.strictEqual(r.abatido, 2100);
  assert.strictEqual(cent(2792.67 - (4846.53 - r.abatido)), 46.14);
});

console.log('\n§4 bordas');
caso('sem pagamentos', () => assert.deepStrictEqual(abatimentosDoCiclo({ ...nov, pagamentos: [] }), { abatido: 0, pagoDepois: 0 }));
caso('valor zero ou negativo é ignorado', () => {
  const r = abatimentosDoCiclo({ ...nov, totalAnterior: 0, pagamentos: [{ valor: 0, data: '2026-10-10' }, { valor: -5, data: '2026-10-11' }] });
  assert.deepStrictEqual(r, { abatido: 0, pagoDepois: 0 });
});
caso('anterior zerada: tudo abate', () => {
  const r = abatimentosDoCiclo({ ...nov, totalAnterior: 0, pagamentos: [{ valor: 100, data: '2026-10-10' }] });
  assert.deepStrictEqual(r, { abatido: 100, pagoDepois: 0 });
});

console.log('§5 só no Mercado Pago (o recorte medido)');
caso('reconhece o MP como a Polp o nomeia (e variações)', () => {
  for (const n of ['Mercado Pago', 'MERCADO PAGO', 'Mercadopago', 'mercado_pago PJ']) assert.ok(instituicaoEhMercadoPago(n), n);
});
caso('outros emissores ficam de fora (o ruído deles zerava fatura em aberto)', () => {
  for (const n of ['Nubank', 'CAIXA', 'Bradesco', 'Banco Inter', 'Mercado', '', null]) assert.ok(!instituicaoEhMercadoPago(n), String(n));
});

console.log(`\n${ok} ok · ${falhou} falharam`);
process.exit(falhou ? 1 : 0);
