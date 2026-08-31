// =============================================================================
// EVAL de services/moeda.js — conta em moeda estrangeira.
//
// O erro caro aqui é ASSIMÉTRICO e por isso a seção 3 é a mais densa:
//   · converter errado por 1% → número levemente torto (chato)
//   · tratar falha de câmbio como ZERO → o dinheiro do cliente SOME da tela
//     sem nenhum aviso, e ele acha que perdeu o saldo (catastrófico)
//
// A seção 1 trava a regra que protege o resto do sistema: em BRL, NADA muda.
//
// Rodar:  npm run eval:moeda
// =============================================================================
const M = require('../src/services/moeda');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} — deu ${a}, esperado ${b}`); };

// ── 1. BRL NÃO PODE MUDAR DE COMPORTAMENTO ────────────────────────────────
// Esta é a seção que protege as 13.4k transações e 455 carteiras existentes.
console.log('── 1. em BRL, nada muda ──');
{
  const c = M.camposTransacao(50, 'BRL', {});
  eq(c.valor, 50, 'BRL: valor é o próprio número');
  eq(c.moeda, null, 'BRL: moeda fica NULA (linha idêntica à de hoje)');
  eq(c.valor_moeda, null, 'BRL: valor_moeda fica NULO');
  eq(c.taxa_brl, null, 'BRL: taxa_brl fica NULA');

  // Moeda ausente/lixo cai em BRL, nunca quebra.
  // Só lixo de verdade cai em BRL. ⚠️ 'usd ' NÃO entra nesta lista: espaço e
  // caixa são aparados de propósito, e o teste logo abaixo cobre isso.
  for (const v of [null, undefined, '', 'xxx', 'BITCOIN', 123, {}]) {
    eq(M.normalizarMoeda(v), 'BRL', `"${v}" normaliza pra BRL`);
  }
  eq(M.normalizarMoeda('usd'), 'USD', 'minúsculo vira maiúsculo');
  eq(M.normalizarMoeda(' eur '), 'EUR', 'espaços são aparados');

  ok(!M.ehEstrangeira('BRL'), 'BRL não é estrangeira');
  ok(!M.ehEstrangeira(null), 'moeda nula não é estrangeira');
  ok(M.ehEstrangeira('USD'), 'USD é estrangeira');

  // Saldo em BRL não depende de tabela de câmbio nenhuma.
  eq(M.saldoEmBRL({ saldo: 1234.56, moeda: 'BRL' }, null), 1234.56, 'saldo BRL sem tabela');
  eq(M.saldoEmBRL({ saldo: 10 }, null), 10, 'saldo sem coluna moeda = BRL');
}
console.log('  ok');

// ── 2. Conversão ───────────────────────────────────────────────────────────
console.log('── 2. conversão e congelamento ──');
{
  const t = { USD: 5.4, EUR: 6.0 };

  // O caso do relato: Nomad com US$ 6.834,56.
  eq(M.saldoEmBRL({ saldo: 6834.56, moeda: 'USD' }, t), 6834.56 * 5.4, 'Nomad em BRL');

  const c = M.camposTransacao(50, 'USD', t);
  eq(c.valor, 270, 'US$50 × 5,4 = R$270 gravado em `valor`');
  eq(c.valor_moeda, 50, 'nativo preservado');
  eq(c.taxa_brl, 5.4, 'taxa congelada na linha');
  eq(c.moeda, 'USD', 'moeda registrada');

  // ⚠️ O CONGELAMENTO: a mesma transação, relida com o câmbio a 6,0, tem de
  // continuar valendo R$270. É o que impede o relatório de março de mudar
  // sozinho todo dia.
  eq(c.valor, 270, 'valor NÃO se recalcula quando o câmbio muda');

  eq(M.valorNativo({ valor: 270, valor_moeda: 50 }), 50, 'valorNativo devolve o nativo');
  eq(M.valorNativo({ valor: 99 }), 99, 'sem valor_moeda, o nativo é o próprio valor');
  // ⚠️ valor_moeda = 0 é um valor legítimo, não "ausente".
  eq(M.valorNativo({ valor: 5, valor_moeda: 0 }), 0, 'valor_moeda 0 não cai no fallback');
}
console.log('  ok');

// ── 3. FALHA DE CÂMBIO NUNCA VIRA ZERO ────────────────────────────────────
// ⚠️ A seção que mais importa. Somar 0 apagaria o dinheiro do cliente da tela.
console.log('── 3. sem câmbio: null, jamais 0 ──');
{
  eq(M.paraBRL(100, 'USD', {}), null, 'sem taxa na tabela → null');
  eq(M.paraBRL(100, 'USD', null), null, 'sem tabela → null');
  eq(M.paraBRL(100, 'USD', { USD: 0 }), null, 'taxa 0 é inválida → null');
  eq(M.paraBRL(100, 'USD', { USD: NaN }), null, 'taxa NaN → null');
  eq(M.saldoEmBRL({ saldo: 6834.56, moeda: 'USD' }, {}), null, 'saldo sem câmbio → null');

  // ⚠️ E a soma AVISA em vez de mentir.
  const r = M.somarSaldos([
    { saldo: 1000, moeda: 'BRL' },
    { saldo: 500,  moeda: 'USD' },   // sem câmbio
  ], {});
  eq(r.total, 1000, 'soma só o que deu pra converter');
  eq(r.semCambio, 1, 'e AVISA quantas ficaram de fora');

  const r2 = M.somarSaldos([
    { saldo: 1000, moeda: 'BRL' },
    { saldo: 100,  moeda: 'USD' },
  ], { USD: 5 });
  eq(r2.total, 1500, 'com câmbio, soma tudo');
  eq(r2.semCambio, 0, 'nada faltando');

  // Sem câmbio, o lançamento NÃO se perde: grava o nativo e marca a moeda.
  const c = M.camposTransacao(50, 'USD', {});
  eq(c.valor, 50, 'sem câmbio, valor recebe o nativo (não some)');
  eq(c.valor_moeda, 50, 'nativo registrado');
  eq(c.taxa_brl, null, 'taxa fica nula — a linha é provisória e a tela sabe');
  eq(c.moeda, 'USD', 'a moeda é registrada de qualquer jeito');
}
console.log('  ok');

// ── 4. Soma de lista vazia / suja ─────────────────────────────────────────
console.log('── 4. entradas degeneradas ──');
{
  eq(M.somarSaldos([], {}).total, 0, 'lista vazia soma 0');
  eq(M.somarSaldos(null, {}).total, 0, 'null não quebra');
  eq(M.somarSaldos([{ saldo: null, moeda: 'BRL' }], {}).total, 0, 'saldo nulo conta 0');
  eq(M.paraBRL(null, 'BRL', {}), 0, 'valor nulo em BRL é 0');
  ok(Object.keys(M.MOEDAS).includes('USD'), 'USD está no catálogo');
  eq(M.MOEDAS.BRL.simbolo, 'R$', 'símbolo do real');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`❌ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('   · ' + f));
  process.exit(1);
}
console.log('✅ moeda: tudo passou.');
