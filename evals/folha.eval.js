// =============================================================================
// EVAL da folha (services/folha).
//
// Comissão errada não dá erro: dá pagamento errado, e quem descobre é o
// funcionário. Custo de encargos errado não dá erro: dá preço mal formado.
//
// Rodar:  npm run eval:folha
// =============================================================================
const { custoFuncionario, comissaoDe, resumoMensal } = require('../src/services/folha');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${b}, veio ${a})`);

// ── 1. Comissão ────────────────────────────────────────────────────────────
console.log('── 1. comissão ──');
eq(comissaoDe(100000, 5), 5000, '5% de R$1.000 = R$50');
eq(comissaoDe(100000, 0), 0, 'sem percentual, sem comissão');
eq(comissaoDe(100000, null), 0, 'pct nulo não vira NaN');
eq(comissaoDe(0, 10), 0, 'venda zero → comissão zero');
eq(comissaoDe(100000, -5), 0, 'pct negativo não gera comissão negativa');
// Arredondamento: dinheiro é inteiro em centavos.
eq(comissaoDe(3333, 3), 100, 'arredonda pro centavo (3% de 33,33 = 1,00)');
eq(comissaoDe(10, 15), 2, 'centavo quebrado arredonda, não trunca');
// Meio por cento existe (comissão de vendedor de alto ticket).
eq(comissaoDe(1000000, 0.5), 5000, 'aceita percentual fracionário');
console.log('  ok');

// ── 2. Custo do funcionário sem encargos ───────────────────────────────────
console.log('── 2. sem encargos ──');
{
  const c = custoFuncionario(200000);
  eq(c.total, 200000, 'desligado: custo = salário');
  eq(c.encargos, 0, 'nenhum encargo');
  eq(c.detalhe.length, 0, 'nada a detalhar');
  eq(custoFuncionario(null).total, 0, 'salário nulo → zero, sem NaN');
  eq(custoFuncionario(-5000).total, 0, 'salário negativo não vira crédito');
}
console.log('  ok');

// ── 3. Encargos: os ~30% que somem da planilha caseira ─────────────────────
console.log('── 3. com encargos ──');
{
  const c = custoFuncionario(100000, { encargos: true }); // R$1.000
  const por = Object.fromEntries(c.detalhe.map(d => [d.chave, d.valor]));
  eq(por.fgts, 8000, 'FGTS 8%');
  eq(por.decimo_terceiro, 8333, '13º = 1/12');
  eq(por.ferias, 11111, 'férias + 1/3 = 1,3333/12');
  // O esquecido: FGTS incide sobre 13º e férias também.
  eq(por.fgts_provisoes, 1556, 'FGTS sobre as provisões');
  eq(por.inss_patronal, undefined, 'INSS patronal fora por padrão (está no DAS do Simples)');
  eq(c.encargos, 29000, 'encargos somam ~29% do salário');
  eq(c.total, 129000, 'custo total = salário + encargos');

  // Regime que cobra INSS patronal por fora.
  const comInss = custoFuncionario(100000, { encargos: true, inssPatronal: true });
  eq(comInss.encargos, 49000, 'com INSS patronal sobe pra ~49%');
  ok(comInss.total > c.total, 'INSS patronal aumenta o custo');
}
console.log('  ok');

// ── 4. Resumo do mês ───────────────────────────────────────────────────────
console.log('── 4. resumo mensal ──');
{
  const f = { salario: 150000, encargos: false };
  const r = resumoMensal(f, 30000); // R$300 de comissão apurada
  eq(r.a_pagar, 180000, 'sai do caixa: salário + comissão');
  eq(r.custo_total, 180000, 'sem encargos, custo = o que sai');

  const clt = resumoMensal({ salario: 150000, encargos: true }, 30000);
  eq(clt.a_pagar, 180000, 'provisão NÃO sai do caixa hoje');
  ok(clt.custo_total > clt.a_pagar, 'mas o custo real é maior que o pagamento');
  eq(clt.custo_total, 150000 + clt.encargos + 30000, 'custo = salário + encargos + comissão');

  // Sem comissão apurada não pode virar NaN nem negativo.
  eq(resumoMensal(f).comissao, 0, 'sem comissão informada → 0');
  eq(resumoMensal(f, -100).comissao, 0, 'comissão negativa é ignorada');
  eq(resumoMensal(null).a_pagar, 0, 'funcionário ausente não quebra');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`❌ ${falhas.length} falha(s):`);
  falhas.forEach(f => console.error('   · ' + f));
  process.exit(1);
}
console.log('✅ Folha: todos os casos passaram.');
