// =============================================================================
// EVAL do custo médio móvel (services/estoque).
//
// É o número mais perigoso do módulo: ele decide a margem de TODA venda daquele
// produto. Errar aqui não dá erro em lugar nenhum — só faz o dono achar que
// lucra mais (ou menos) do que lucra, e tomar decisão de preço em cima disso.
//
// Rodar:  npm run eval:estoque
// =============================================================================
const { custoMedioApos } = require('../src/services/estoque');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

// ── 1. A média clássica ────────────────────────────────────────────────────
console.log('── 1. custo médio móvel ──');
// 10 unidades a R$10, entram 10 a R$14 → R$12
ok(custoMedioApos(10, 1000, 10, 1400) === 1200, '10@10 + 10@14 → 12,00');
// Peso proporcional: 30 a R$10 + 10 a R$14 → R$11
ok(custoMedioApos(30, 1000, 10, 1400) === 1100, '30@10 + 10@14 → 11,00 (pondera pela quantidade)');
// Entrada mais barata puxa pra baixo
ok(custoMedioApos(10, 2000, 10, 1000) === 1500, '10@20 + 10@10 → 15,00');
console.log('  ok');

// ── 2. Bordas que quebram a fórmula ingênua ────────────────────────────────
console.log('── 2. bordas ──');
// Saldo zero: média com zero daria divisão por zero ou manteria um custo velho
// que não corresponde a nada em prateleira.
ok(custoMedioApos(0, 1000, 5, 1800) === 1800, 'saldo zero → assume o custo da compra');
ok(custoMedioApos(0, 0, 5, 1800) === 1800, 'produto novo (sem custo) → custo da compra');
// Saldo negativo (aconteceu uma venda antes da entrada ser lançada).
ok(custoMedioApos(-3, 1000, 5, 1800) === 1800, 'saldo negativo → custo da compra, não média maluca');
// Brinde/bonificação: custo zero não pode zerar o estoque inteiro.
ok(custoMedioApos(10, 1200, 5, 0) === 1200, 'entrada de custo ZERO (brinde) mantém o custo');
// Quantidade inválida não muda nada.
ok(custoMedioApos(10, 1200, 0, 1800) === 1200, 'quantidade zero não altera o custo');
ok(custoMedioApos(10, 1200, -5, 1800) === 1200, 'quantidade negativa não altera o custo');
console.log('  ok');

// ── 3. Arredondamento — dinheiro é inteiro em centavos ─────────────────────
console.log('── 3. centavos ──');
// 3@10,00 + 1@13,33 = 43,33/4 = 10,8325 → 1083 centavos
ok(custoMedioApos(3, 1000, 1, 1333) === 1083, 'arredonda pro centavo mais próximo');
ok(Number.isInteger(custoMedioApos(7, 999, 3, 1777)), 'resultado é sempre inteiro (centavos)');
console.log('  ok');

// ── 4. Sequência real de uma loja ──────────────────────────────────────────
// O ponto: depois de VENDER, o custo NÃO muda. Recalcular na saída é o erro que
// faz o custo derreter a cada venda e o lucro aparecer inflado.
console.log('── 4. sequência compra → venda → compra ──');
{
  let saldo = 0, custo = 0;
  // Compra 1: 10 a R$10
  custo = custoMedioApos(saldo, custo, 10, 1000); saldo += 10;
  ok(custo === 1000 && saldo === 10, 'após 1ª compra: 10 un a 10,00');

  // Vende 4 — saldo cai, CUSTO NÃO MUDA
  saldo -= 4;
  ok(custo === 1000 && saldo === 6, 'venda NÃO altera o custo médio');

  // Compra 2: 10 a R$16 → (6×10 + 10×16) / 16 = 220/16 = 13,75
  custo = custoMedioApos(saldo, custo, 10, 1600); saldo += 10;
  ok(custo === 1375, 'após 2ª compra: 13,75 (média sobre o que SOBROU, não sobre o comprado)');
  ok(saldo === 16, 'saldo 16');

  // Margem: vender a R$20 rende 6,25 — não 10 (custo da 1ª) nem 4 (custo da 2ª)
  ok(2000 - custo === 625, 'margem real usa o custo médio, não a última compra');
}
console.log('  ok');

console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) {
  console.log('\n── Falhas ──');
  falhas.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}
