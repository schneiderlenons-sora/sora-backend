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

// ── 4. ⚠️ A REGRA CASA COM A DESCRIÇÃO DE ONDE NASCEU ─────────────────────
// O `termoDe` tira ruído do MEIO da frase, e o casamento era por pedaço
// contíguo: a regra do "Valer para todas" não casava nem com o próprio
// lançamento (38,9% das descrições da base, 61,3% das de Pix). Caso real:
// reclassificar "Pix recebido MARIZA MARIA DA SILVA SANTOS" não mudava os
// outros Pix dela.
console.log('── 4. regra casa com a própria descrição ──');
{
  const contem = (termo) => ({ termo, modo_match: 'contem' });
  const reais = [
    'Pix recebido MARIZA MARIA DA SILVA SANTOS',
    'Transferência enviada|BIANCA APARECIDA DIAS DA SILVA',
    'Compra no débito|PADARIA E MERCEARIA BR',
    'BARBEARIA DO ZE LTDA',
    'PIX - ENVIADO   29/07 15:13 DIVINA SOUZA DE NOVAIS',
    'MERCADOLIVRE  PARC 04/06 OSASCO      BR',
    'Pagamento - Maria Lana ME',
    'PIX FERNANDOPEIXOTO 0512',
  ];
  for (const d of reais) {
    ok(R.casaRegra(R.normalizar(d), contem(R.termoDe(d))), `regra extraída de "${d}" casa com ela mesma`);
  }
  // E com as próximas do mesmo lugar, que variam no meio.
  const divina = contem(R.termoDe('Pix enviado DIVINA SOUZA DE NOVAIS'));
  ok(R.casaRegra(R.normalizar('Pix - Enviado - 27/06 11:00 DIVINA SOUZA DE NOVAIS'), divina), 'mesma pessoa com data e hora no meio');
  const mariza = contem(R.termoDe('Pix recebido MARIZA MARIA DA SILVA SANTOS'));
  ok(R.casaRegra(R.normalizar('PIX RECEBIDO - 03/10 MARIZA MARIA DA SILVA SANTOS'), mariza), 'o próximo Pix da mesma pessoa');
  // Ordem importa: as palavras soltas em outra ordem não são o mesmo nome.
  ok(!R.casaRegra(R.normalizar('Pix recebido SANTOS SILVA MARIA MARIZA'), mariza), 'palavras fora de ordem não casam');
  ok(!R.casaRegra(R.normalizar('Pix recebido MARIZA COSTA'), mariza), 'outra Mariza não casa');
  ok(!R.casaRegra(R.normalizar('Pix recebido MARIA DA SILVA SANTOS'), mariza), 'faltando uma palavra não casa');
  // "exato" continua exato.
  ok(!R.casaRegra(R.normalizar('Pix recebido MARIZA MARIA DA SILVA SANTOS'), { termo: 'mariza maria silva santos', modo_match: 'exato' }),
    'texto exato não ganha a folga das palavras em ordem');
}
console.log('  ok');

// ── 5. ⚠️ CASAMENTO AO CONTRÁRIO SÓ COM NOME DE VERDADE ────────────────────
// A regra "Pix recebido MARIZA MARIA DA SILVA SANTOS" jogava em Extras todo
// lançamento "Pix recebido" de outras pessoas, porque a descrição cabia dentro
// do texto da regra. Decisão do usuário: o reverso fica, mas só com nome real.
console.log('── 5. reverso só com nome de verdade ──');
{
  const contem = (termo) => ({ termo, modo_match: 'contem' });
  const casa = (d, termo) => R.casaRegra(R.normalizar(d), contem(termo));
  // Continua valendo — é pra isto que o reverso existe.
  ok(casa('ALLREDE', 'boleto allrede'), '"allrede" cai na regra "boleto allrede"');
  ok(casa('VIVO', 'vivo celular vivo movel go'), '"vivo" cai na regra da Vivo');
  ok(casa('Embreagem carro', 'mecanico embreagem carro'), 'pedaço com nome real continua casando');
  // Não vale mais.
  ok(!casa('Pix recebido', 'pix recebido mariza maria da silva santos'), '⚠️ "Pix recebido" de outra pessoa não cai na regra da Mariza');
  ok(!casa('Pagamento', 'pagamento guarda roupa de ana liz'), '"Pagamento" genérico não cai numa regra de Móveis');
  ok(!casa('PG', 'pg sano suplementos l br'), 'código curto ("pg") não casa');
  ok(!casa('GOL', 'pecas o gol'), 'três letras ("gol") não casam');
  ok(!casa('Mercado', 'supermercado junior'), 'pedaço de palavra ("mercado" ≠ "supermercado") não casa');
  // O caminho normal (descrição contém o termo) não foi afetado.
  ok(casa('Pix recebido MARIZA MARIA DA SILVA SANTOS', 'pix recebido mariza maria da silva santos'), 'a própria Mariza segue casando');
}
console.log('  ok');

console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) {
  console.log('\n── Falhas ──');
  falhas.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}
