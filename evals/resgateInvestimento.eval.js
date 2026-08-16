// =============================================================================
// EVAL do resgate de investimento.
//
// O erro fácil aqui não estoura em lugar nenhum: ele vira uma RENTABILIDADE
// ERRADA na tela do cliente. Se o resgate baixa só o valor atual e deixa o
// aportado intacto, um saque parcial faz o painel exibir prejuízo num
// investimento que só teve retirada.
//
// Rodar:  npm run eval:resgate
// =============================================================================
const { aplicarResgate } = require('../src/services/resgateInvestimento');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// ── 1. Resgate parcial preserva a rentabilidade ─────────────────────────
console.log('── 1. parcial mantém a rentabilidade ──');
{
  // Aportou 1.000, virou 1.200 (+20%). Resgata 600 = metade do valor atual.
  const r = aplicarResgate({ valor_aportado: 1000, valor_atual: 1200, quantidade: 100 }, 600);
  ok(r.ok, 'resgate válido');
  eq(r.patch.valor_atual, 600, 'valor atual cai o valor resgatado');
  eq(r.patch.valor_aportado, 500, 'aportado cai PROPORCIONAL (metade), não fica 1000');
  eq(r.patch.quantidade, 50, 'quantidade cai proporcional');
  eq(r.zerou, false, 'não zerou');

  // A prova do que importa: a rentabilidade continua +20%.
  const rentDepois = ((r.patch.valor_atual - r.patch.valor_aportado) / r.patch.valor_aportado) * 100;
  ok(Math.abs(rentDepois - 20) < 0.01, `rentabilidade continua +20% (veio ${rentDepois.toFixed(2)}%)`);
}
console.log('  ok');

// ── 2. Resgate total zera tudo ──────────────────────────────────────────
console.log('── 2. resgate total ──');
{
  const r = aplicarResgate({ valor_aportado: 1000, valor_atual: 1200, quantidade: 100 }, 1200);
  ok(r.ok, 'resgate total é válido');
  eq(r.zerou, true, 'marca que zerou');
  eq(r.patch.valor_atual, 0, 'valor atual zerado');
  eq(r.patch.valor_aportado, 0, 'aportado zerado');
  eq(r.patch.quantidade, 0, 'quantidade zerada');

  // ⚠️ Quem quer sacar tudo digita o número que está NA TELA, já arredondado.
  // Sem a folga de 1 centavo, "resgatar tudo" falharia por diferença invisível.
  const r2 = aplicarResgate({ valor_aportado: 1000, valor_atual: 1200, quantidade: 100 }, 1200.01);
  ok(r2.ok, 'tolera 1 centavo a mais (arredondamento da tela)');
  eq(r2.zerou, true, '…e trata como resgate total');
}
console.log('  ok');

// ── 3. O que NÃO pode passar ────────────────────────────────────────────
console.log('── 3. recusas ──');
{
  ok(!aplicarResgate({ valor_atual: 1000 }, 0).ok, 'zero é recusado');
  ok(!aplicarResgate({ valor_atual: 1000 }, -50).ok, 'negativo é recusado');
  ok(!aplicarResgate({ valor_atual: 1000 }, 'abc').ok, 'texto é recusado');
  ok(!aplicarResgate({ valor_atual: 0 }, 100).ok, 'investimento zerado não resgata');
  // Resgatar MAIS do que existe criaria valor negativo na carteira.
  const r = aplicarResgate({ valor_atual: 1000, valor_aportado: 900 }, 5000);
  ok(!r.ok, 'acima do saldo é recusado');
  ok(/1000\.00/.test(r.erro), 'o erro DIZ quanto ele tem (não só "inválido")');
}
console.log('  ok');

// ── 4. Campos ausentes não viram zero inventado ─────────────────────────
console.log('── 4. campos ausentes ──');
{
  // Investimento sem quantidade (CDB, Tesouro — não tem "cotas")
  const r = aplicarResgate({ valor_atual: 1000, valor_aportado: 1000 }, 400);
  ok(r.ok, 'resgata sem quantidade');
  ok(!('quantidade' in r.patch), 'não inventa quantidade quando não existe');
  eq(r.patch.valor_atual, 600, 'valor atual correto');
  eq(r.patch.valor_aportado, 600, 'aportado proporcional');

  // Sem valor_aportado registrado
  const r2 = aplicarResgate({ valor_atual: 500 }, 200);
  ok(r2.ok, 'resgata sem aportado');
  ok(!('valor_aportado' in r2.patch), 'não inventa aportado quando não existe');
  eq(r2.patch.valor_atual, 300, 'valor atual correto');
}
console.log('  ok');

// ── 5. Centavos ─────────────────────────────────────────────────────────
console.log('── 5. arredondamento ──');
{
  // Um terço de 1000 — o clássico que gera dízima.
  const r = aplicarResgate({ valor_aportado: 900, valor_atual: 1000 }, 333.33);
  ok(r.ok, 'resgate com centavos');
  eq(r.patch.valor_atual, 666.67, 'valor atual com 2 casas');
  // 900 * (1 - 0.33333) = 600.003 → 600.00
  eq(r.patch.valor_aportado, 600, 'aportado arredondado a 2 casas');
  ok(String(r.patch.valor_atual).split('.')[1]?.length <= 2, 'nunca mais de 2 casas no dinheiro');
}
console.log('  ok');

// ── Resultado ────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ resgate de investimento: todos os casos passaram');
