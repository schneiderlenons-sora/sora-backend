// =============================================================================
// EVAL — consultar UMA compra parcelada ("parcelas do presente da Juliana").
//
// Um cliente pediu pelo WhatsApp "me mostre o valor e quantidade de parcelas
// do presente da Juliana" e não conseguiu: a regra local só conhecia "quantas
// parcelas", a IA não tinha o comando, e `listar_parcelas` não filtrava.
//
// ⚠️ O que este eval protege, além do caso do cliente: a consulta NUNCA pode
// sequestrar registro/pagamento ("paguei a parcela do carro") nem mudar o que
// "minhas parcelas" faz hoje (listar todas).
//
// Rodar:  npm run eval:consulta-parcela
// =============================================================================
const { extrairTermoParcela, termoCasaCompra } = require('../src/services/consultaParcela');
const { interpretarRapido } = require('../src/handlers/interpretador');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

console.log('── 1. o caso do cliente ──');
{
  const frase = 'Sora, me mostre o valor e quantidade de parcelas do presente da Juliana';
  const r = interpretarRapido(frase);
  ok(r && r.acao === 'listar_parcelas', `vira listar_parcelas (veio ${JSON.stringify(r)})`);
  ok(r && /presente da juliana/i.test(r.termo || ''), `com o termo da compra (veio ${JSON.stringify(r && r.termo)})`);
  // A compra real dele: "Presente Juliana" no Mercado Pago Crédito.
  ok(termoCasaCompra(r && r.termo, 'Presente Juliana', 'Mercado Pago Crédito'), 'o termo casa a compra real');
  // ⚠️ E NÃO casa a outra compra de presente dele, de outra pessoa.
  ok(!termoCasaCompra(r && r.termo, 'presente Jamille', 'Mercado Pago Crédito'), 'não traz o presente da Jamille');
}
console.log('  ok');

console.log('── 2. jeitos naturais de perguntar uma compra ──');
const CASOS = [
  ['quantas parcelas faltam do celular', 'celular'],
  ['quantas parcelas faltam pro notebook', 'notebook'],
  ['valor da parcela do celular', 'celular'],
  ['detalhes da compra parcelada do fone', 'fone'],
  ['quero ver as parcelas do presente', 'presente'],
  ['parcelas do nubank', 'nubank'],
  ['quanto é a parcela do meu carro', 'carro'],
  ['a parcela da tv vence quando', 'tv'],
];
for (const [frase, esperado] of CASOS) {
  const t = extrairTermoParcela(frase);
  ok(t.toLowerCase() === esperado, `"${frase}" → termo "${esperado}" (veio "${t}")`);
}
console.log('  ok');

console.log('── 3. ⚠️ NÃO sequestra registro nem pagamento ──');
for (const frase of [
  'paguei a parcela do carro',
  'comprei um celular parcelado do mercado livre',
  'parcelei o notebook com joão',
  'antecipar parcela do fone',
  'quitar parcelas da tv',
  'gastei 50 na parcela do curso',
]) ok(extrairTermoParcela(frase) === '', `"${frase}" não é consulta`);
console.log('  ok');

console.log('── 4. ⚠️ "listar todas" continua exatamente igual ──');
for (const frase of [
  'parcelas', 'minhas parcelas', 'como estão minhas parcelas', 'quantas parcelas tenho pra pagar',
  'compras parceladas', 'parcelas em aberto', 'parcelas a pagar', 'parcelas pendentes',
]) {
  ok(extrairTermoParcela(frase) === '', `"${frase}" não extrai termo`);
  const r = interpretarRapido(frase);
  ok(r && r.acao === 'listar_parcelas' && r.termo === undefined, `"${frase}" segue listando TODAS (veio ${JSON.stringify(r)})`);
}
// Termo que não nomeia compra: continua como antes (sem filtro).
for (const frase of ['parcelas do cartão', 'parcelas da fatura', 'parcelas do mês']) {
  ok(extrairTermoParcela(frase) === '', `"${frase}" não vira filtro`);
}
console.log('  ok');

console.log('── 5. casamento da compra ──');
ok(termoCasaCompra('celular', 'Celular Samsung', 'Nubank Crédito'), 'palavra da descrição');
ok(termoCasaCompra('nubank', 'Celular Samsung', 'Nubank Crédito'), 'nome do cartão também vale');
ok(termoCasaCompra('presente nubank', 'Presente', 'Nubank Crédito'), 'descrição + cartão juntos');
ok(termoCasaCompra('presentes', 'Presente Juliana', 'MP'), 'plural casa singular');
ok(termoCasaCompra('geladeira', 'Geladeira Brastemp', null), 'cartão ausente não quebra');
ok(termoCasaCompra('CELULAR', 'celular', 'x'), 'sem diferença de caixa');
ok(termoCasaCompra('cafe', 'Café Especial', 'x'), 'sem diferença de acento');
ok(!termoCasaCompra('celular iphone', 'Celular Samsung', 'Nubank'), 'TODAS as palavras têm de aparecer');
ok(!termoCasaCompra('tv', 'Notebook', 'Nubank'), 'nada a ver não casa');
ok(!termoCasaCompra('', 'Notebook', 'Nubank'), 'termo vazio não casa nada');
console.log('  ok');

console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) {
  falhas.forEach((f) => console.log(`  · ${f}`));
  process.exit(1);
}
