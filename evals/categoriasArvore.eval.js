// =============================================================================
// EVAL da árvore de categorias (services/categoriasArvore).
//
// Os dois bugs reais que este arquivo existe pra impedir:
//   1. emoji 📌 em categoria que TEM emoji no banco (o mapa cravado no código
//      não acompanhou a taxonomia v3/v4);
//   2. "quanto gastei com alimentação" não achar nada, porque iFood e Lanches
//      são FILHAS e o nome delas não contém a palavra.
//
// Rodar:  npm run eval:categorias-arvore
// =============================================================================
const { montarArvore, emojiPara, familiaDe } = require('../src/services/categoriasArvore');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// Recorte fiel da taxonomia real (migrations 084→087 + 103).
const LINHAS = [
  { id: '1',  nome: 'Alimentação',  icone: '🧃', parent_id: null },
  { id: '11', nome: 'Supermercado', icone: '🛒', parent_id: '1' },
  { id: '12', nome: 'Lanches',      icone: '🌮', parent_id: '1' },
  { id: '13', nome: 'Padaria',      icone: '🥖', parent_id: '1' },
  { id: '2',  nome: 'Delivery',     icone: '🛵', parent_id: null },
  { id: '21', nome: 'iFood',        icone: '🛵', parent_id: '2' },
  { id: '3',  nome: 'Saúde',        icone: '🩺', parent_id: null },
  { id: '31', nome: 'Dentista',     icone: '🦷', parent_id: '3' },
  { id: '4',  nome: 'Financeiro',   icone: '💰', parent_id: null },
  { id: '41', nome: 'Fatura',       icone: '💳', parent_id: '4' },
  { id: '5',  nome: 'Autocuidado',  icone: '🧼', parent_id: null },
  { id: '51', nome: 'Barbeiro',     icone: '💈', parent_id: '5' },
  { id: '6',  nome: 'Empreendimento', icone: '💼', parent_id: null },
  { id: '61', nome: 'Facebook Ads', icone: '📣', parent_id: '6' },
  { id: '62', nome: 'Ferramentas',  icone: '🧰', parent_id: '6' },
  { id: '7',  nome: 'Sem ícone',    icone: null, parent_id: '6' },
];
const A = montarArvore(LINHAS);

// ── 1. O bug do 📌 ─────────────────────────────────────────────────────────
console.log('── 1. emoji vem do banco ──');
{
  eq(emojiPara('Dentista', A),   '🦷', 'Dentista');
  eq(emojiPara('Fatura', A),     '💳', 'Fatura');
  eq(emojiPara('Lanches', A),    '🌮', 'Lanches');
  eq(emojiPara('Financeiro', A), '💰', 'Financeiro');
  eq(emojiPara('Barbeiro', A),   '💈', 'Barbeiro');
  // Nome que chega com o emoji colado (lançamento antigo) tem de casar igual.
  eq(emojiPara('🦷 Dentista', A), '🦷', 'nome com emoji colado');
  eq(emojiPara('dentista', A),    '🦷', 'minúsculo');
  eq(emojiPara('DENTISTA', A),    '🦷', 'maiúsculo');
  eq(emojiPara('Alimentacao', A), '🧃', 'sem acento casa com "Alimentação"');
}
console.log('  ok');

// ── 2. Marca com logo usa o emoji do PAI ───────────────────────────────────
// No painel essas categorias aparecem com o logo oficial; o emoji do banco
// nunca é visto. 📣 não diz nada em "Facebook Ads" — 💼 diz.
console.log('── 2. marcas ──');
{
  eq(emojiPara('Facebook Ads', A), '💼', 'Facebook Ads usa o emoji de Empreendimento');
  // ⚠️ A regra é curta de propósito: estendida a todas as marcas, Adidas e
  // Mercado Livre viravam 🚚 (Encomendas) e ficavam indistinguíveis. Emoji
  // próprio e específico vence o do pai.
  eq(emojiPara('iFood', A),        '🛵', 'iFood mantém o próprio emoji');
  eq(emojiPara('Ferramentas', A),  '🧰', 'categoria comum mantém o próprio emoji');
  // Sem emoji próprio → herda do pai em vez de cair no 📌.
  eq(emojiPara('Sem ícone', A),    '💼', 'sem emoji próprio herda do pai');
}
console.log('  ok');

// ── 3. Desconhecida ────────────────────────────────────────────────────────
console.log('── 3. fora da árvore ──');
{
  eq(emojiPara('Categoria Inventada', A), '📌', 'desconhecida cai no 📌');
  eq(emojiPara('', A), '📌', 'vazio');
  eq(emojiPara(null, A), '📌', 'null não quebra');
  // O mapa antigo continua valendo como rede de segurança.
  eq(emojiPara('Uber', A, () => '🚗'), '🚗', 'fallback do chamador é usado');
  eq(emojiPara('Dentista', A, () => '🚗'), '🦷', 'o banco vence o fallback');
}
console.log('  ok');

// ── 4. Perguntar pelo pai soma os filhos ───────────────────────────────────
console.log('── 4. família ──');
{
  const f = familiaDe('alimentação', A);
  ok(f.includes('Alimentação'), 'inclui a própria categoria');
  ok(f.includes('Lanches') && f.includes('Supermercado') && f.includes('Padaria'),
     'inclui todas as subcategorias');
  // Delivery é categoria de TOPO na v4, irmã de Alimentação — e mesmo assim o
  // usuário conta o iFood como alimentação. Sem isto, "quanto gastei com
  // alimentação" devolvia só os lanches e parecia que a Sora tinha perdido
  // metade dos gastos.
  ok(f.includes('Delivery') && f.includes('iFood'), 'assunto afim: delivery entra em alimentação');
  // Sem acento e minúsculo, como o usuário digita no zap.
  eq(familiaDe('alimentacao', A).length, f.length, 'sem acento funciona igual');
  eq(familiaDe('comida', A).includes('iFood'), true, '"comida" também resolve');

  // Perguntar pela FILHA traz só ela: quem pede "ifood" não quer o mercado.
  const i = familiaDe('ifood', A);
  eq(i.length, 1, 'subcategoria não puxa os irmãos');
  eq(i[0], 'iFood', 'e é ela mesma');

  // Termo que não é categoria → null, e o chamador segue com busca textual
  // (senão "uber" ou "padaria do zé" deixariam de achar pela observação).
  eq(familiaDe('churrasco no domingo', A), null, 'texto livre não vira categoria');
  eq(familiaDe('', A), null, 'vazio');

  // Parcial: "mercado" tem de achar Supermercado (e não Mercado Livre, ausente
  // aqui) — o mais próximo em tamanho vence.
  ok(familiaDe('mercado', A).includes('Supermercado'), 'casamento parcial');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`❌ ${falhas.length} falha(s):`);
  falhas.forEach(f => console.error('   · ' + f));
  process.exit(1);
}
console.log('✅ Árvore de categorias: todos os casos passaram.');
