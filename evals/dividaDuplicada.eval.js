// =============================================================================
// EVAL do casamento "dívida manual × dívida do Open Finance".
//
// CASO DE ORIGEM (base real): um cliente lançou o empréstimo do Nubank à mão
// como "Empréstimo · R$ 18.255,88 · 36× R$ 629,51" (anotou o SALDO DEVEDOR no
// lugar do valor contratado). Ao conectar o Open Finance, o banco mandou o
// MESMO contrato como "Credito Pessoal · R$ 8.000 · 36× R$ 629,51" — e a aba
// passou a mostrar dois empréstimos, inflando o total devido.
//
// O casamento é DE PROPÓSITO estreito: deixar uma duplicata passar custa muito
// menos do que FUNDIR duas dívidas diferentes do usuário (o que apagaria dados
// que ele digitou). Por isso o valor total fica de fora — é justamente onde os
// dois divergem.
//
// Rodar:  npm run eval:divida-duplicada
// =============================================================================
const { mesmaDividaManual, normTexto } = require('../src/services/polpCelcoinSync');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };

// O contrato como o Open Finance entrega (normalizeDivida).
const doBanco = {
  titulo: 'Credito Pessoal', credor: 'Nubank',
  valor_total: 8000, valor_parcela: 629.51, parcelas_total: 36,
};

// ── 1. O caso real ───────────────────────────────────────────────────────
console.log('── 1. o empréstimo duplicado da base ──');
{
  const manual = {
    titulo: 'Empréstimo', credor: 'Nubank', status: 'em_atraso', of_id: null,
    valor_total: 18255.88, valor_parcela: 629.51, parcelas_total: 36,
  };
  ok(mesmaDividaManual(manual, doBanco),
    'o "Empréstimo · 18.255,88" lançado à mão é o mesmo contrato do "Credito Pessoal · 8.000" do banco');
}
console.log('  ok');

// ── 2. Não pode fundir dívidas diferentes ───────────────────────────────
console.log('── 2. o que NÃO pode casar ──');
{
  const base = { credor: 'Nubank', status: 'ativa', of_id: null, valor_parcela: 629.51, parcelas_total: 36, titulo: 'Empréstimo' };

  ok(!mesmaDividaManual({ ...base, parcelas_total: 48 }, doBanco),
    'prazo diferente (48 × 36) = outro contrato');
  ok(!mesmaDividaManual({ ...base, valor_parcela: 761.24 }, doBanco),
    'parcela diferente = outro contrato (é o outro empréstimo real do mesmo cliente)');
  ok(!mesmaDividaManual({ ...base, credor: 'Itaú', titulo: 'Empréstimo' }, doBanco),
    'outro banco não casa');
  ok(!mesmaDividaManual({ ...base, status: 'quitada' }, doBanco),
    'dívida quitada não é a que está em curso');
  ok(!mesmaDividaManual({ ...base, of_id: '019fbd54-ba7c' }, doBanco),
    'linha que JÁ veio do Open Finance nunca é adotada de novo (senão dois contratos viram um)');
  ok(!mesmaDividaManual({ ...base, parcelas_total: null }, doBanco),
    'sem nº de parcelas não dá pra afirmar que é a mesma');
  ok(!mesmaDividaManual({ ...base, valor_parcela: 0 }, doBanco),
    'sem valor de parcela não dá pra afirmar que é a mesma');
  ok(!mesmaDividaManual(base, { ...doBanco, credor: null }),
    'sem o banco na ponta do OF, não casa');
  ok(!mesmaDividaManual(null, doBanco) && !mesmaDividaManual(base, null),
    'entrada nula não quebra');
}
console.log('  ok');

// ── 3. Tolerâncias que DEVEM casar ──────────────────────────────────────
console.log('── 3. o que ainda casa ──');
{
  const base = { credor: 'Nubank', status: 'ativa', of_id: null, valor_parcela: 629.51, parcelas_total: 36, titulo: 'Empréstimo' };

  ok(mesmaDividaManual({ ...base, valor_parcela: 629.5 }, doBanco),
    'centavo de diferença na parcela ainda é o mesmo contrato (arredondamento do usuário)');
  ok(mesmaDividaManual({ ...base, credor: 'nubank' }, doBanco),
    'caixa diferente casa');
  ok(mesmaDividaManual({ ...base, credor: 'NuBank ' }, doBanco),
    'espaço sobrando casa');
  ok(mesmaDividaManual({ ...base, credor: null, titulo: 'Empréstimo Nubank' }, doBanco),
    'banco no TÍTULO conta (muita gente não preenche o credor)');
  ok(mesmaDividaManual({ ...base, status: 'em_atraso' }, doBanco),
    'em atraso continua sendo a dívida em curso');

  // Acento: o OF manda "Itaú" e o usuário digita "Itau".
  ok(mesmaDividaManual(
    { ...base, credor: 'Itau' },
    { ...doBanco, credor: 'Itaú' },
  ), 'acento não pode impedir o casamento');
}
console.log('  ok');

// ── 4. normTexto ─────────────────────────────────────────────────────────
console.log('── 4. normalização de texto ──');
{
  ok(normTexto('Itaú') === 'itau', 'tira acento');
  ok(normTexto('  BANCO   do Brasil ') === 'banco do brasil', 'colapsa espaço e baixa a caixa');
  ok(normTexto('C6 Bank') === 'c6 bank', 'mantém número');
  ok(normTexto(null) === '' && normTexto(undefined) === '', 'nulo vira string vazia');
}
console.log('  ok');

// ── Resultado ────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ dívida duplicada (manual × Open Finance): todos os casos passaram');
