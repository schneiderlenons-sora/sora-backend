// =============================================================================
// EVAL do parser de "posso comprar?" (services/compraTexto).
//
// Dois riscos, e eles NÃO têm o mesmo peso:
//   · não entender a pergunta → a pessoa recebe um "não entendi". Chato.
//   · entender demais → "comprei um celular por 3000" vira uma CONSULTA em vez
//     de um LANÇAMENTO, e o gasto some do controle sem ninguém perceber.
//
// O segundo é grave, então a seção 3 (o que NÃO pode disparar) é a mais densa
// deste arquivo de propósito.
//
// Rodar:  npm run eval:compra
// =============================================================================
const { interpretarCompra } = require('../src/services/compraTexto');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// ── 1. As formas de perguntar ──────────────────────────────────────────────
console.log('── 1. formas de perguntar ──');
{
  const c = interpretarCompra('Oráculo, posso comprar um celular em 10x de 500?');
  ok(c, 'entende a frase do mockup');
  eq(c.parcelas, 10, 'parcelas');
  eq(c.parcela, 50000, 'parcela em centavos');
  eq(c.total, 500000, 'total = parcela × parcelas');

  eq(interpretarCompra('posso comprar um celular de 3000?').total, 300000, 'à vista: total');
  eq(interpretarCompra('posso comprar um celular de 3000?').parcelas, 1, 'à vista: 1 parcela');

  ok(interpretarCompra('dá pra comprar uma tv de 2500 em 12x'), 'aceita "dá pra"');
  ok(interpretarCompra('da pra comprar uma tv de 2500 em 12x'), 'aceita sem acento');
  ok(interpretarCompra('vale a pena parcelar 1200 em 6x?'), 'aceita "vale a pena"');
  ok(interpretarCompra('consigo comprar uma geladeira de 4000?'), 'aceita "consigo"');
  ok(interpretarCompra('tenho como comprar um notebook de 5000'), 'aceita "tenho como"');
  ok(interpretarCompra('devo comprar um carro de 60000?'), 'aceita "devo"');
  ok(interpretarCompra('compensa financiar 20000 em 24x?'), 'aceita "compensa" + financiar');
}
console.log('  ok');

// ── 2. Parcela × total — a conta que muda tudo ─────────────────────────────
console.log('── 2. parcela × total ──');
{
  // ⚠️ "10x de 500" = R$ 5.000. Ler o 500 como TOTAL daria R$ 50/mês e
  // aprovaria praticamente qualquer compra. É o erro mais caro deste arquivo.
  const p = interpretarCompra('posso comprar em 10x de 500');
  eq(p.total, 500000, '"10x de 500" → total R$ 5.000');
  eq(p.parcela, 50000, '"10x de 500" → parcela R$ 500');

  const t = interpretarCompra('posso comprar um celular de 3000 em 10x');
  eq(t.total, 300000, '"3000 em 10x" → o valor dito é o TOTAL');
  eq(t.parcela, 30000, '"3000 em 10x" → parcela derivada R$ 300');

  const v = interpretarCompra('posso comprar uma tv em 12 vezes de 250?');
  eq(v.parcelas, 12, '"em 12 vezes de 250" → 12 parcelas');
  eq(v.parcela, 25000, '"em 12 vezes de 250" → parcela');
  eq(v.total, 300000, '"em 12 vezes de 250" → total');

  const e = interpretarCompra('posso comprar um sofá em dez vezes de 300');
  eq(e && e.parcelas, 10, 'parcelas por extenso');
  eq(e && e.total, 300000, 'total com parcelas por extenso');

  const br = interpretarCompra('posso comprar um celular de R$ 1.500,00?');
  eq(br && br.total, 150000, 'formato BR com milhar e centavos');

  const pr = interpretarCompra('posso comprar uma moto em 24 parcelas de 480');
  eq(pr && pr.parcelas, 24, '"24 parcelas de 480"');
  eq(pr && pr.total, 1152000, 'total de 24×480');
}
console.log('  ok');

// ── 3. O QUE NÃO PODE DISPARAR ─────────────────────────────────────────────
// A seção que protege o lançamento de gastos.
console.log('── 3. não dispara (protege o lançamento) ──');
{
  const naoPode = [
    // Passado = transação. Se qualquer um destes virar consulta, o usuário
    // perde o registro do gasto achando que registrou.
    'comprei um celular por 3000',
    'comprei um celular em 10x de 500',
    'compramos uma tv de 2500',
    'já comprei o celular de 3000',
    'gastei 500 no mercado',
    'paguei 300 de luz',
    'vendi 3 bolos por 90',
    'quanto gastei esse mês',
    'quanto paguei de luz em julho',
    // Verbo de compra SEM permissão — não é pergunta.
    'comprar um celular de 3000',
    'lista de compras do mercado',
    // Permissão SEM valor — não há o que avaliar.
    'posso comprar um celular?',
    'vale a pena comprar agora?',
    'da pra comprar?',
    // Permissão + valor, mas sem verbo de aquisição.
    'posso pagar 500 de aluguel?',
    // Conversa comum
    'bom dia',
    'me mostra meus gastos',
    'qual meu saldo',
  ];
  for (const f of naoPode) {
    const r = interpretarCompra(f);
    ok(r === null, `NÃO pode disparar: "${f}" (veio ${JSON.stringify(r)})`);
  }
}
console.log('  ok');

// ── 4. Meio de pagamento ───────────────────────────────────────────────────
console.log('── 4. meio de pagamento ──');
{
  // ⚠️ null (não disse) ≠ false (disse que é à vista). Com null o handler
  // decide pelo nº de parcelas; com false ele nem checa limite de cartão.
  eq(interpretarCompra('posso comprar um celular de 3000 no cartão?').noCartao, true, 'diz cartão');
  eq(interpretarCompra('posso comprar um celular de 3000 no crédito?').noCartao, true, 'diz crédito');
  eq(interpretarCompra('posso comprar um celular de 3000 à vista?').noCartao, false, 'diz à vista');
  eq(interpretarCompra('posso comprar um celular de 3000 no pix?').noCartao, false, 'diz pix');
  eq(interpretarCompra('posso comprar um celular de 3000?').noCartao, null, 'não disse → null');
}
console.log('  ok');

// ── 5. Limites de sanidade ─────────────────────────────────────────────────
console.log('── 5. sanidade ──');
{
  // Número grande demais pra ser parcelamento não pode virar 2026 parcelas.
  const r = interpretarCompra('posso comprar um carro de 50000 em 2026 vezes');
  ok(!r || r.parcelas <= 48, 'não aceita parcelamento absurdo');

  const um = interpretarCompra('posso comprar um celular de 3000 em 1x');
  eq(um && um.parcelas, 1, '1x é à vista');

  eq(interpretarCompra(''), null, 'string vazia');
  eq(interpretarCompra(null), null, 'null');
  eq(interpretarCompra(undefined), null, 'undefined');
}
console.log('  ok');

// ── 6. O nome do item (cosmético) ──────────────────────────────────────────
console.log('── 6. nome do item ──');
{
  // Entra só na resposta, nunca no cálculo — pode ser null sem prejuízo.
  eq(interpretarCompra('posso comprar um celular de 3000?').item, 'celular', 'item simples');
  const s = interpretarCompra('posso comprar uma máquina de lavar de 2000?');
  ok(s && (s.item === null || /m[áa]quina/i.test(s.item)), 'item composto não vira lixo');
  const so = interpretarCompra('posso comprar 3000 em 10x');
  ok(!so || so.item === null, 'só número não vira nome de item');
}
console.log('  ok');

// ── Resultado ──────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.log(`❌ ${falhas.length} falha(s):`);
  for (const f of falhas) console.log('   · ' + f);
  process.exit(1);
}
console.log('✅ compraTexto: tudo passou');
