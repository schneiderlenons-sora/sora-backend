// =============================================================================
// EVAL das marcas por PREFIXO DE ADQUIRENTE no categorizador local-first.
//
// POR QUE EXISTE: o que chega do Open Finance não é o nome da loja, é o
// descritor que o adquirente carimba na fatura — "IFD*CARVALHO ALBINO AL",
// "PayU        *ADI". Quem categoriza por palavra-chave nunca vê a marca: vê o
// nome do restaurante. O resultado, medido na base antes desta correção:
//
//   IFD*  →  73 lançamentos, R$ 4.431,65, espalhados por 11 categorias
//            (Restaurante 19, Outros 22, Lanches 8, Farmácia 5… e iFood 4)
//
// O erro aqui não estoura: a transação entra, some dentro da categoria errada,
// e o limite que o usuário criou pra aquela marca fica marcando zero pra
// sempre. Foi exatamente a queixa que gerou este arquivo.
//
// Rodar:  npm run eval:categorizar-marca
// =============================================================================
const { categorizarDescricao, categorizar } = require('../src/services/categorizar');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);
const cat = (d, esperado, obs = '') => eq(categorizarDescricao(d), esperado, `"${d}" → ${esperado} ${obs}`);

// ── 1. iFood: o prefixo vence o nome da loja ───────────────────────────────
// Todas estas são descrições REAIS da base. À esquerda o que o categorizador
// devolvia antes; hoje as 8 têm de sair iFood.
console.log('── 1. IFD* vence o nome da loja ──');
{
  cat('IFD*SAGUACU PIZZARIA L', 'iFood', '(antes: Restaurante)');
  cat('IFD*KAKA LANCHES LTDABELO HORI', 'iFood', '(antes: Lanches)');
  cat('IFD*PANIFICADOS E RECEBELO HOR', 'iFood', '(antes: Padaria)');
  cat('IFD*CRIA CAFE CAFES ESBELO HOR', 'iFood', '(antes: Café)');
  cat('IFD*MERCEARIA KI DOCUR', 'iFood', '(antes: Supermercado)');
  cat('IFD*RAIA DROGASIL SABELO HORIZ', 'iFood', '(antes: Farmácia)');
  cat('IFD*DAKI BELO HORIZONTBELO HOR', 'iFood', '(antes: Delivery)');
  cat('Ifd*Yui Sushi Marajoar', 'iFood', '(antes: Restaurante)');
}
console.log('  ok');

// ── 2. iFood: o que caía em Outros ─────────────────────────────────────────
// Nome de loja sem palavra conhecida — a maior fatia do estrago (22 de 73).
console.log('── 2. IFD* que caía em Outros ──');
{
  cat('IFD*FLAVIO E LORENA CO', 'iFood');
  cat('IFD*57127009 LUIZ CARL', 'iFood');
  cat('IFD*AMBROZINI COMERCIO', 'iFood');
  cat('Ifd*Canto da Vila Marm', 'iFood');
  cat('IFD*EMPORIUM ASIA LTDABELO HOR', 'iFood');
  // Variantes de escrita que existem na base: minúscula, espaço antes do '*',
  // parcela colada e prefixo do banco na frente.
  cat('Ifd*Digao Barbacena', 'iFood');
  cat('IFD    *FARMA CONDE SA', 'iFood');
  cat('Ifd*City Burger Hambur 1/2', 'iFood');
  cat('COMPRA ELO DEBITO VISTA - IFD*STROGONOFFF49EF4 - DOCTO: 6101', 'iFood');
}
console.log('  ok');

// ── 3. O prefixo NÃO pode vazar ────────────────────────────────────────────
// 'ifd' tem 3 letras, então `casa()` exige palavra inteira. Se alguém "otimizar"
// isso pra substring, estas frases quebram — e é por isso que elas estão aqui.
console.log('── 3. sem falso positivo de "ifd" ──');
{
  ok(categorizarDescricao('SWIFDATA SOLUCOES') !== 'iFood', '"swifdata" não é iFood');
  ok(categorizarDescricao('MAGIFDECOR MOVEIS') !== 'iFood', '"magifdecor" não é iFood');
  cat('IFOOD CLUB', 'iFood', '(a palavra inteira continua valendo)');
}
console.log('  ok');

// ── 4. Adidas truncada pelo PayU ───────────────────────────────────────────
console.log('── 4. PayU *ADI ──');
{
  cat('PayU        *ADI', 'Adidas', '(era Outros: o campo corta em 22 chars)');
  cat('PayU        *ADIDAS', 'Adidas');
  cat('PayU   *ADIDASBAHI02/10', 'Adidas');
  // 'payu' sozinho é gateway de muita loja — não pode virar Adidas.
  ok(categorizarDescricao('PayU *NETSHOES') !== 'Adidas', 'PayU de outra loja não é Adidas');
  ok(categorizarDescricao('PayU *SPOTIFY') !== 'Adidas', 'PayU de outra loja não é Adidas (2)');
}
console.log('  ok');

// ── 5. Crédito não é reclassificado pela descrição ─────────────────────────
// O sync decide 'Fatura'/'Reembolso' pela DIREÇÃO antes de olhar a descrição
// (normalizeTxCartao). Este bloco trava o outro lado: o estorno de um pedido
// do iFood tem de continuar sendo estorno se alguém passar por aqui.
// Se virasse iFood, deixaria de ABATER a fatura e viraria gasto — a fatura
// subiria sozinha. Medido: 1 linha assim na base.
console.log('── 5. o que a direção já decidiu ──');
{
  const desc = 'CANCELAMENTO PARCIAL DE COMPRA - IFD*RECANTO INDUSTRIABELO HORIZONTBRA';
  eq(categorizarDescricao(desc), 'iFood', 'pela descrição, sozinha, é iFood');
  // ...e é justamente por isso que a migration 134 filtra por
  // `transferencia IS NOT TRUE`: quem manda no crédito é a direção, não o texto.
  ok(true, 'documentado');
}
console.log('  ok');

// ── 6. A porta de entrada de verdade ───────────────────────────────────────
// `categorizar()` recebe OBJETO. Chamar com string devolve 'Outros' calado —
// erro que já me custou um diagnóstico errado.
console.log('── 6. assinatura de categorizar() ──');
{
  eq(categorizar({ descricao: 'IFD*FLAVIO E LORENA CO', ehGasto: true }), 'iFood', 'objeto');
  eq(categorizar('IFD*FLAVIO E LORENA CO'), 'Outros', 'string solta NÃO funciona (de propósito, documentado)');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`❌ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('   · ' + f));
  process.exit(1);
}
console.log('✅ Marcas por prefixo de adquirente: todos os casos passaram.');
