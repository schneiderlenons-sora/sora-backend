// =============================================================================
// EVAL das regras de categoria por ESTABELECIMENTO (services/regrasCategoria).
//
// Só a parte PURA (termo + casamento) — nada de banco. É aqui que mora o risco:
// um termo largo demais vira uma regra que captura transação de outro lugar, e
// aí a correção do usuário estraga a categoria de coisa não relacionada.
//
// Rodar:   npm run eval:regras
// =============================================================================
const R = require('../src/services/regrasCategoria');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

// ── 1. termoDe(): tira o ruído que o adquirente gruda no nome ───────────────
console.log('── 1. termoDe() ──');
ok(R.termoDe('FernandoPeixoto') === 'fernandopeixoto', 'nome colado');
ok(R.termoDe('PIX FERNANDOPEIXOTO 0512') === 'fernandopeixoto', 'tira "PIX" e o código numérico');
ok(R.termoDe('Pagamento - Maria Lana ME') === 'maria lana', 'tira "Pagamento" e "ME"');
ok(R.termoDe('BARBEARIA DO ZE LTDA') === 'barbearia ze', 'tira "do" e "LTDA"');
ok(R.termoDe('  ') === '', 'vazio continua vazio');
// Descrição 100% ruído não pode virar termo VAZIO — regra vazia casaria com
// tudo e reclassificaria a base inteira.
ok(R.termoDe('PIX') === 'pix', 'só ruído → usa a descrição inteira, não vazio');
console.log('  ok');

// ── 2. Mesma loja escrita de jeitos diferentes → MESMO termo ───────────────
console.log('── 2. grafias equivalentes ──');
ok(R.termoDe('FERNANDO PEIXOTO') === R.termoDe('fernando peixoto'), 'caixa alta × baixa');
ok(R.termoDe('Açaí do João') === R.termoDe('ACAI DO JOAO'), 'acento não separa');
ok(R.termoDe('Clínica São Lucas') === 'clinica sao lucas', 'acento removido');
console.log('  ok');

// ── 3. normalizar() casa com o do categorizar.js ───────────────────────────
// Se as duas normalizações divergirem, a regra do usuário nunca casa com o que
// o motor de palavras vê — e a feature não funciona sem dar erro.
console.log('── 3. normalização idêntica à do categorizador ──');
for (const s of ['APPLE.COM/BILL', 'FACEBK *SY6', 'Açaí & Cia', 'MERCADOLIVRE*ML']) {
  const doCategorizador = s.toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  ok(R.normalizar(s) === doCategorizador, `normalizar("${s}") diverge do categorizar.js`);
}
console.log('  ok');

console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) {
  console.log('\n── Falhas ──');
  falhas.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}
