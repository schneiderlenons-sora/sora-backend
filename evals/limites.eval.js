// =============================================================================
// EVAL do alerta de limite (services/limites) — a parte pura.
//
// Três caminhos dependem desta regra agora (zap, painel e Open Finance), e o
// erro aqui não estoura: o alerta simplesmente não chega, ou chega com o texto
// quebrado, e ninguém percebe até o cliente reclamar.
//
// Rodar:  npm run eval:limites
// =============================================================================
const { templateLimite, ALVO_GERAL, limpaCat } = require('../src/services/limites');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// ── 1. A frase tem de ler bem depois de "seu limite de ___" ────────────────
console.log('── 1. rótulo ──');
{
  eq(ALVO_GERAL, 'gasto geral', 'limite geral vira "gasto geral"');
  // "Aviso sobre o seu limite de geral." estava errado — foi correção do usuário.
  const frase = `Aviso sobre o seu limite de ${templateLimite('Ana', ALVO_GERAL, 80, 8, 10).params[1]}.`;
  eq(frase, 'Aviso sobre o seu limite de gasto geral.', 'frase montada');
  ok(!/limite de geral/.test(frase), 'nunca "de geral"');
}
console.log('  ok');

// ── 2. Parâmetros que a Cloud API aceita ───────────────────────────────────
// Recusa \n, tab e 4+ espaços seguidos; e parâmetro VAZIO também é rejeitado.
console.log('── 2. formato dos params ──');
{
  const casos = [
    templateLimite('Lenon Schneider', 'Alimentação', 82.4, 652, 800),
    templateLimite(null, null, 100, 1234.5, 1000),
    templateLimite('   ', '🍔 Alimentação', 95.6, 3.1, 3.5),
    templateLimite('Maria', 'Casa e decoração', 0, 0, 100),
  ];
  for (const c of casos) {
    eq(c.params.length, 5, 'sempre 5 parâmetros');
    for (const p of c.params) {
      ok(String(p).trim().length > 0, `param vazio em ${JSON.stringify(c.params)}`);
      ok(!/[\n\t]/.test(p), `quebra/tab em ${JSON.stringify(p)}`);
      ok(!/\s{4,}/.test(p), `4+ espaços em ${JSON.stringify(p)}`);
      // Espaço não separável (U+00A0) é o que o Intl injeta em style:currency —
      // invisível no editor e problema só em produção.
      ok(!/[  ]/.test(p), `espaço não separável em ${JSON.stringify(p)}`);
    }
  }
}
console.log('  ok');

// ── 3. Valores e percentual ────────────────────────────────────────────────
console.log('── 3. números ──');
{
  const p = templateLimite('Ana', 'Mercado', 82.4, 652, 800).params;
  eq(p[2], '82%', 'percentual arredondado, com %');
  eq(p[3], 'R$ 652,00', 'gasto formatado');
  eq(p[4], 'R$ 800,00', 'teto formatado');
  // Separador de milhar: sem ele "R$ 1234,50" lê como valor menor de relance.
  eq(templateLimite('A', 'x', 10, 1234.5, 15230.9).params[3], 'R$ 1.234,50', 'milhar no gasto');
  eq(templateLimite('A', 'x', 10, 1234.5, 15230.9).params[4], 'R$ 15.230,90', 'milhar no teto');
  // Estourar o teto é o caso mais comum do alerta.
  eq(templateLimite('A', 'x', 137.8, 1378, 1000).params[2], '138%', 'acima de 100% não trava');
  // Sujeira não pode virar NaN no meio da frase.
  eq(templateLimite('A', 'x', 10, null, undefined).params[3], 'R$ 0,00', 'null vira zero');
  ok(!templateLimite('A', 'x', NaN, 1, 1).params.some((v) => /NaN/.test(v)), 'nunca imprime NaN');
}
console.log('  ok');

// ── 4. Nome do destinatário ────────────────────────────────────────────────
console.log('── 4. saudação ──');
{
  eq(templateLimite('Lenon Schneider Silva', 'x', 1, 1, 1).params[0], 'Lenon', 'só o primeiro nome');
  eq(templateLimite('', 'x', 1, 1, 1).params[0], 'tudo bem', 'sem nome → "Oi, tudo bem!"');
  eq(templateLimite(null, 'x', 1, 1, 1).params[0], 'tudo bem', 'null não quebra');
  eq(templateLimite('   ', 'x', 1, 1, 1).params[0], 'tudo bem', 'só espaços conta como sem nome');
  ok(templateLimite('A'.repeat(120), 'x', 1, 1, 1).params[0].length <= 60, 'nome truncado');
}
console.log('  ok');

// ── 5. Comparação de categoria (subcategoria conta pro pai) ────────────────
console.log('── 5. normalização ──');
{
  eq(limpaCat('🦷 Dentista'), 'dentista', 'tira emoji');
  eq(limpaCat('Alimentação'), 'alimentacao', 'tira acento');
  eq(limpaCat('  CASA e Decoração '), 'casa e decoracao', 'minúsculo e sem borda');
  eq(limpaCat(null), '', 'null vira vazio');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`❌ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('   · ' + f));
  process.exit(1);
}
console.log('✅ Alerta de limite: todos os casos passaram.');
