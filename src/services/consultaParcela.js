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

// =============================================================================
// PARCELA JÁ COBRADA — e o agrupamento que o comando "parcelas" mostra.
//
// ⚠️ `pago` SOZINHO NÃO RESPONDE ISSO. Parcela futura nasce `pago: false` — no
// painel, no WhatsApp e no sync do banco — e nada a vira quando o dia chega.
// Medido em 14/09/2026: 30 parcelas do Open Finance (R$ 14.270,19) e 240
// digitadas à mão (R$ 21.812,15) com a data já passada seguiam "não pagas".
//
// O relato: "parcelas" listou JIM.COM PROSED ES como a pagar, com as duas
// parcelas cobradas. A 2/2 (03/09) está na fatura de setembro — a soma do
// ciclo 09/08→08/09 dá R$ 4.018,54, igual aos pagamentos do banco no centavo.
//
// Cobrada = paga (inclusive ANTECIPADA, que fica paga com data futura) OU o
// dia dela já chegou — a mesma definição com que `normalizeTxCartao` grava o
// `pago` na importação; o que faltava era aplicá-la de novo quando o dia chega.
// ⚠️ É "cobrada", não "quitada": a parcela da fatura ainda aberta já saiu do
// cronograma, mas a fatura dela pode não ter sido paga. O texto diz "cobradas".
// =============================================================================

const TZ = 'America/Sao_Paulo';
const SO_DATA = /^\d{4}-\d{2}-\d{2}$/;
const MEIA_UTC = /^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?(Z|\+00:?00)$/;

/**
 * O dia da transação em São Paulo — a mesma regra de `lib/data-br.ts`.
 * `transacoes.data` guarda data pura (meia-noite UTC, fatiar) E instante real
 * (converter pro fuso); fatiar o instante erra o dia entre 21h e meia-noite.
 */
function diaSP(v) {
  if (!v) return '';
  const s = String(v);
  if (SO_DATA.test(s) || MEIA_UTC.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 10);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** A parcela já foi cobrada? `hoje` = 'YYYY-MM-DD' em São Paulo. */
function parcelaJaCobrada(t, hoje) {
  if (t && t.pago === true) return true;
  const dia = diaSP(t && t.data);
  return !!dia && dia <= hoje;
}

/**
 * Agrupa as parcelas por compra. `comGrupo` = linhas com `parcela_grupo`
 * (painel, WhatsApp novo, Open Finance); `semGrupo` = legado do WhatsApp
 * antigo, observação "Desc (2/3)" — só as NÃO pagas, como sempre veio.
 * Devolve um Map chave → { desc, cartao, total, pagas, restantes,
 * valorRestante, valorParcela, valorTotal, proxima, legado }.
 */
function agruparParcelas(comGrupo, semGrupo, hoje) {
  const grupos = new Map();
  // `moeda`: a do CARTÃO quando ele não está na base do grupo (migration 168);
  // null = na base. Quem escreve o texto formata com ela.
  const novo = (desc, cartao, total, valor, legado, moeda = null) => ({
    desc, cartao, total: total || 0, pagas: 0, restantes: 0, valorRestante: 0, valorRestanteBase: 0,
    valorParcela: valor || 0, proxima: null, valorTotal: 0, linhas: 0, legado, moeda,
  });
  // Na moeda do CARTÃO (migration 168): parcela de cartão fora da moeda do
  // grupo guarda o original em `valor_moeda`. Sem ele (todo cartão hoje) é o
  // `valor` de sempre. Quem busca as linhas precisa pedir `valor_moeda`.
  const valorDe = (t) => (t.valor_moeda ?? t.valor) || 0;
  const contar = (g, t) => {
    g.linhas++;
    g.valorTotal += valorDe(t);
    if (parcelaJaCobrada(t, hoje)) return;
    g.restantes++;
    g.valorRestante += valorDe(t);
    // Na moeda do GRUPO — é o que soma compras de cartões diferentes.
    g.valorRestanteBase += (t.valor || 0);
    if (!g.proxima || String(t.data) < String(g.proxima.data)) g.proxima = { data: t.data };
  };

  for (const t of comGrupo || []) {
    if (!t || !t.parcela_grupo) continue;
    const g = grupos.get(t.parcela_grupo)
      || novo((t.observacao || 'Compra').trim() || 'Compra', t.carteira_nome, t.parcela_total, valorDe(t), false, t.moeda || null);
    if (t.parcela_total) g.total = t.parcela_total;
    contar(g, t);
    grupos.set(t.parcela_grupo, g);
  }

  for (const t of semGrupo || []) {
    const mm = String((t && t.observacao) || '').match(/^(.*?)\s*\((\d+)\/(\d+)\)\s*$/);
    if (!mm) continue;
    const desc = mm[1].trim() || 'Compra';
    const total = parseInt(mm[3], 10);
    const chave = `legacy:${desc.toLowerCase()}:${(t.carteira_nome || '').toLowerCase()}:${total}`;
    const g = grupos.get(chave) || novo(desc, t.carteira_nome, total, valorDe(t), true, t.moeda || null);
    contar(g, t);
    grupos.set(chave, g);
  }

  for (const g of grupos.values()) {
    // ⚠️ Com o total conhecido, pagas = total − a vencer. Cobre parcela que nem
    // existe como linha: o legado só busca as não pagas, e o banco pode mandar
    // a 2/2 sem marcador na 1/2 (foi o caso do JIM.COM PROSED).
    g.pagas = g.total ? Math.max(0, g.total - g.restantes) : g.linhas - g.restantes;
    if (g.total > g.linhas) g.valorTotal += (g.total - g.linhas) * g.valorParcela;
    g.valorTotal = Math.round(g.valorTotal * 100) / 100;
    g.valorRestante = Math.round(g.valorRestante * 100) / 100;
    g.valorRestanteBase = Math.round(g.valorRestanteBase * 100) / 100;
  }
  return grupos;
}
module.exports = {
  extrairTermoParcela, termoCasaCompra, VERBO_DE_ACAO, RE_PARCELAS_DE,
  diaSP, parcelaJaCobrada, agruparParcelas,
};
