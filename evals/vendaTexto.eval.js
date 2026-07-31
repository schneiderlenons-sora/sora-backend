// =============================================================================
// EVAL do parser de venda por WhatsApp (services/vendaTexto).
//
// Dois riscos opostos:
//   · não entender a frase → o dono desiste e volta pro caderno;
//   · entender demais → "vendi bem hoje" vira uma venda de R$ 0 no caixa.
//
// Rodar:  npm run eval:venda-texto
// =============================================================================
const { interpretarVenda } = require('../src/services/vendaTexto');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// ── 1. A frase do dia a dia ────────────────────────────────────────────────
console.log('── 1. frases comuns ──');
{
  const v = interpretarVenda('vendi 3 bolos por 90 reais pra dona Maria');
  ok(v, 'entende a frase completa');
  eq(v.quantidade, 3, 'quantidade');
  eq(v.produto, 'bolos', 'produto');
  eq(v.valor, 9000, 'valor em centavos (total)');
  eq(v.cliente, 'dona Maria', 'cliente');

  const v2 = interpretarVenda('vendi 2 pizzas 50');
  eq(v2.quantidade, 2, 'quantidade sem "por"');
  eq(v2.produto, 'pizzas', 'produto sem "por"');
  eq(v2.valor, 5000, "número solto no fim é o preço (é como se fala no balcão)");

  const v3 = interpretarVenda('vendi 2 pizzas por 50');
  eq(v3.valor, 5000, 'com "por" o número é preço');

  const v4 = interpretarVenda('vendi um corte de cabelo por 40 reais');
  eq(v4.quantidade, 1, 'quantidade por extenso');
  eq(v4.produto, 'corte de cabelo', 'produto com várias palavras');
  eq(v4.valor, 4000, 'valor');
}
console.log('  ok');

// ── 2. Total × unitário — a ambiguidade que dá diferença de caixa ──────────
console.log('── 2. total × cada ──');
{
  eq(interpretarVenda('vendi 3 bolos por 90').valor, 9000, 'sem "cada" o valor é o TOTAL');
  const cada = interpretarVenda('vendi 3 bolos a 30 cada');
  eq(cada.valor, 9000, 'com "cada" multiplica pela quantidade');
  eq(cada.valor_unitario, 3000, 'guarda o unitário informado');
  eq(interpretarVenda('vendi 4 pães a R$ 2,50 cada').valor, 1000, 'decimal com vírgula × quantidade');
}
console.log('  ok');

// ── 3. Formas de pagamento e fiado ─────────────────────────────────────────
console.log('── 3. pagamento ──');
{
  eq(interpretarVenda('vendi 1 bolo por 50 no pix').forma, 'pix', 'pix');
  eq(interpretarVenda('vendi 1 bolo por 50 em dinheiro').forma, 'dinheiro', 'dinheiro');
  eq(interpretarVenda('vendi 1 bolo por 50 no cartão').forma, 'debito', 'cartão → débito');
  eq(interpretarVenda('vendi 1 bolo por 50 no crédito').forma, 'credito', 'crédito');

  // Fiado tem de virar conta a receber: se entrar como pago, o saldo do dia
  // mostra um dinheiro que não está na gaveta.
  const fiado = interpretarVenda('vendi 2 bolos por 60 fiado pra dona Ana');
  eq(fiado.aPrazo, true, 'fiado marca a prazo');
  eq(fiado.cliente, 'dona Ana', 'fiado sem perder o cliente (quem deve importa)');
  eq(interpretarVenda('vendi 1 bolo por 50 anotado').aPrazo, true, '"anotado" também é fiado');
}
console.log('  ok');

// ── 4. Não inventar venda ──────────────────────────────────────────────────
console.log('── 4. não inventar ──');
{
  eq(interpretarVenda('vendi bem hoje'), null, '"vendi bem" não é venda registrável');
  eq(interpretarVenda('hoje foi fraco'), null, 'frase sem gatilho');
  eq(interpretarVenda(''), null, 'vazio');
  eq(interpretarVenda(null), null, 'null não quebra');
  eq(interpretarVenda('gastei 50 no mercado'), null, 'gasto não é venda');
  eq(interpretarVenda('quanto vendi esse mês?'), null, 'pergunta não vira lançamento');
}
console.log('  ok');

// ── 5. Variações do balcão ─────────────────────────────────────────────────
console.log('── 5. variações ──');
{
  eq(interpretarVenda('venda de 120 reais').valor, 12000, '"venda de X reais" sem produto');
  eq(interpretarVenda('vendi R$ 1.500,00 de material').valor, 150000, 'formato BR com milhar');
  eq(interpretarVenda('vendi meio quilo de queijo por 25').quantidade, 0.5, '"meio" vira 0,5');
  eq(interpretarVenda('vendi 2,5 kg de carne por 90').quantidade, 2.5, 'quantidade fracionada');

  const semCliente = interpretarVenda('vendi 5 coxinhas por 25');
  eq(semCliente.cliente, null, 'venda de balcão não tem cliente');
  eq(semCliente.produto, 'coxinhas', 'produto no plural');

  // O nome do cliente não pode engolir o resto da frase.
  const c = interpretarVenda('vendi 1 bolo pra Maria por 40 no pix');
  eq(c.cliente, 'Maria', 'cliente antes do valor');
  eq(c.valor, 4000, 'valor depois do cliente');
  eq(c.forma, 'pix', 'forma depois do valor');
  eq(c.produto, 'bolo', 'produto preservado');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`❌ ${falhas.length} falha(s):`);
  falhas.forEach(f => console.error('   · ' + f));
  process.exit(1);
}
console.log('✅ Venda por texto: todos os casos passaram.');
