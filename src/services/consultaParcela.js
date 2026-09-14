// =============================================================================
// CONSULTAR UMA COMPRA PARCELADA ESPECÍFICA — "parcelas do presente da Juliana".
//
// POR QUE EXISTE. Um cliente pediu pelo WhatsApp:
//   "me mostre o valor e quantidade de parcelas do presente da Juliana"
// e não conseguiu. O comando `listar_parcelas` já existia, mas:
//   1. só listava TODAS as compras — não filtrava por uma;
//   2. a regra local reconhecia "quantas parcelas", não "quantidade de
//      parcelas" — a frase caía na IA;
//   3. a IA não tinha NENHUM exemplo desse comando e pediu mais detalhes.
// A compra existia: 5x de R$ 54,03 no Mercado Pago Crédito, 1 paga.
//
// ⚠️ NÃO É UM COMANDO NOVO — é o `listar_parcelas` ganhando um `termo`
// opcional. Um comando paralelo pra "uma compra" divergiria do de "todas" no
// primeiro ajuste de regra (o que conta como paga, a próxima, o legado).
//
// Sem dependências de propósito: a regra local do interpretador e o handler
// usam as MESMAS funções, e o eval roda sem banco.
// =============================================================================

const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ⚠️ VERBOS DE REGISTRO/PAGAMENTO BARRAM A CONSULTA. "paguei a parcela do
// carro", "comprei o celular parcelado do mercado livre" e "parcelei o
// notebook com o joão" falam de FAZER algo, não de consultar — e cada um tem
// o seu comando (ou vai pra IA). A consulta nunca pode sequestrá-los.
// ⚠️ Infinitivo e imperativo também: "antecipar parcela do fone", "quitar
// parcelas da tv" e "pagar a parcela do carro" são AÇÃO. ("pra pagar" solto
// segue sendo pergunta: "quantas parcelas tenho pra pagar".)
const VERBO_DE_ACAO = /\b(?:paguei|pagou|pagamos|comprei|comprou|compramos|parcelei|parcelou|parcelamos|gastei|gastou|quit(?:ar|ei|ou|a|e)|antecip\w*|lancei|lan[cç]a|lance|registr\w*|adicion\w*|cadastr\w*|cri[ae]r?|crie)\b|\bpag(?:ar|a|ue)\s+(?:a\s+|as\s+)?parcelas?\b/i;

// "parcela(s) [que] [ainda] [faltam|restam|tem|tenho] <preposição> <termo>"
// e "parcelado(a) <preposição> <termo>". A preposição é OBRIGATÓRIA: é ela que
// separa "parcelas do celular" (consulta) de "parcelas em aberto" e
// "parcelas pendentes" (listar tudo, regra antiga).
const RE_PARCELAS_DE = /\bparcel(?:as?|ad[oa]s?|amentos?)\s+(?:(?:que\s+)?(?:ainda\s+)?(?:faltam?|restam?|sobram?|tem|t[eê]m|tenho)\s+)?(?:d[aeo]s?|n[aeo]s?|pr[ao]s?|pra|para|com|[ao]s?)\s+(.+)$/i;

// Termo que não nomeia compra nenhuma — sobra de frases como "quantas parcelas
// tenho PRA PAGAR" ou "parcelas DO CARTÃO". Com ele vazio, a regra antiga
// (listar todas) continua valendo.
const TERMO_VAZIO = /^(?:pagar|vencer|quitar|abert[oa]s?|pendentes?|cart[aã]o|cart[oõ]es|cr[eé]dito|fatura|m[eê]s|esse\s+m[eê]s|este\s+m[eê]s|mim|agora|hoje|ano)$/i;

/**
 * O nome da compra que a frase pergunta, ou '' quando não é essa consulta.
 * @returns {string}
 */
function extrairTermoParcela(msg) {
  const texto = String(msg || '');
  if (VERBO_DE_ACAO.test(texto)) return '';
  const m = texto.match(RE_PARCELAS_DE);
  if (!m) return '';

  let t = m[1].replace(/[?!.;:]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Arrasto no começo: "a compra do", "minha", artigos.
  t = t.replace(/^(?:(?:[ao]s?|d[aeo]s?|minhas?|meus?|compras?)\s+)+/i, '').trim();
  // Cauda de pergunta: "... que faltam", "... a pagar", "... vence quando".
  t = t.replace(/\s+(?:que\s+|ainda\s+)?(?:faltam?|restam?|a\s+pagar|pra\s+pagar|para\s+pagar|em\s+aberto|vence\w*|venceu|quando|qual|quanto|quantas?|t[aá]|est[aá]|foi|ficou)\b.*$/i, '').trim();
  t = t.replace(/[,]+$/, '').trim();
  if (!t || TERMO_VAZIO.test(semAcento(t))) return '';
  return t;
}

const PALAVRAS_VAZIAS = new Set(['o', 'a', 'os', 'as', 'do', 'da', 'dos', 'das', 'de', 'no', 'na', 'nos', 'nas',
  'um', 'uma', 'meu', 'minha', 'meus', 'minhas', 'pro', 'pra', 'para', 'com', 'e']);

const palavras = (s) => semAcento(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
  .filter((w) => w && !PALAVRAS_VAZIAS.has(w));

/**
 * A compra (descrição + cartão) casa com o que a pessoa perguntou?
 *
 * ⚠️ TODAS as palavras do termo têm de aparecer — "presente juliana" não pode
 * trazer o "presente Jamille". Descrição e cartão entram JUNTOS, então
 * "parcelas do nubank" lista as compras daquele cartão e "presente nubank"
 * também funciona. Prefixo vale ("presente" casa "presentes").
 */
function termoCasaCompra(termo, descricao, cartao) {
  const alvo = palavras(termo);
  if (!alvo.length) return false;
  const texto = [...palavras(descricao), ...palavras(cartao)];
  return alvo.every((w) => texto.some((t) => t === w || t.startsWith(w) || (t.length >= 4 && w.startsWith(t))));
}

module.exports = { extrairTermoParcela, termoCasaCompra, VERBO_DE_ACAO, RE_PARCELAS_DE };
