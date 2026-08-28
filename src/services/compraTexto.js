// =============================================================================
// "posso comprar um celular em 10x de 500?" → pergunta pro Oráculo.
//
// LOCAL-FIRST, sem IA (convenção do projeto): é uma pergunta curta e de formato
// previsível, e mandá-la pra OpenAI custaria segundos numa resposta que a pessoa
// espera na hora — além de ficar fora do ar junto com a API.
//
// ⚠️ O GATILHO É A PERMISSÃO, NUNCA O VERBO DE COMPRA.
//
// "comprei um celular por 3000" é um LANÇAMENTO DE GASTO — o coração do produto.
// Se este detector abrisse no verbo "comprar", ele engoliria a transação e a
// pessoa perderia o registro do gasto achando que registrou. Por isso são
// exigidas TRÊS coisas ao mesmo tempo:
//
//   1. marca de permissão/dúvida  (posso, dá pra, consigo, vale a pena, devo…)
//   2. verbo de aquisição          (comprar, pegar, parcelar, financiar…)
//   3. um VALOR                    (sem número não há o que avaliar)
//
// Faltando qualquer uma, devolve null e a mensagem segue o fluxo normal. É
// deliberadamente estreito: deixar passar uma pergunta custa um "não entendi";
// capturar um lançamento custa o gasto do usuário.
//
// Este arquivo só INTERPRETA — quem cruza com o banco e responde é
// handlers/oraculo.js. Separado pra ter eval (evals/compraTexto.eval.js).
// =============================================================================

/** Marca de permissão/conselho. É o que separa pergunta de lançamento. */
const PERMISSAO = /\b(posso|poderia|consigo|conseguiria|da?\s+pra|d[áa]\s+para|tenho\s+como|vale\s+a\s+pena|compensa|devo|seria\s+(?:bom|melhor)|e?\s*seguro|aguento|aguentaria|caberia|cabe\s+no)\b/i;

/** Verbo de aquisição. */
const AQUISICAO = /\b(comprar|adquirir|pegar|parcelar|financiar|trocar\s+de|investir\s+em)\b/i;

/**
 * Perguntas que dispensam o verbo — a intenção já está na frase inteira.
 * "cabe no meu orçamento 500 por mês?" / "aguento uma parcela de 300?"
 */
const FORMA_DIRETA = /\b(cabe\s+no\s+(?:meu\s+)?(?:bolso|or[çc]amento)|aguento\s+(?:uma\s+)?parcela|tenho\s+como\s+pagar)\b/i;

/** Frases que NUNCA são pergunta de compra, mesmo com valor. */
const BLOQUEIO = /\b(comprei|compramos|gastei|paguei|vendi|vendemos|quanto\s+(?:gastei|paguei)|j[áa]\s+comprei)\b/i;

/** "1,5" e "1.5" viram 1.5; "1.500,50" vira 1500.5 (formato BR). */
function numeroBr(txt) {
  if (!txt) return null;
  let s = String(txt).trim().replace(/\s/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/(?<=\d)\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

const PARCELAS_EXTENSO = {
  duas: 2, dois: 2, tres: 3, 'três': 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, quinze: 15,
  dezoito: 18, vinte: 20, 'vinte e quatro': 24,
};

/** Tira acento e baixa a caixa — pra casar "à vista" com "a vista". */
const semAcento = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

const cent = (reais) => Math.round(reais * 100);

/** Ruído que sobra grudado no nome do item. */
const RUIDO_ITEM = /^(?:de|do|da|dos|das|um|uma|uns|umas|o|a|os|as|meu|minha|esse|essa|este|esta)\s+/i;

/**
 * Extrai o nome do que a pessoa quer comprar. É COSMÉTICO — entra na resposta
 * ("um celular de R$ 3.000 cabe"), nunca no cálculo. Por isso pode voltar null
 * sem prejuízo: melhor omitir o nome do que chutar errado.
 */
function extrairItem(t) {
  const m = t.match(/\b(?:comprar|adquirir|pegar|parcelar|financiar|trocar\s+de)\s+(.+?)(?=\s*(?:,|\?|$|\bpor\b|\bde\b\s*R?\$?\s*\d|\bem\b\s*\d|\bà\s+vista\b|\ba\s+vista\b|\bno\b\s+(?:cart|cr[ée]dito|d[ée]bito|pix|dinheiro)))/i);
  if (!m) return null;
  let item = m[1].trim().replace(RUIDO_ITEM, '').trim();
  // Sobrou só número/moeda? Não é nome de coisa nenhuma.
  if (!item || /^(?:r\$)?\s*[\d.,]+$/i.test(item)) return null;
  return item.slice(0, 40);
}

/**
 * Interpreta a pergunta de compra.
 *
 * @returns {null | {
 *   item: string|null,        // o que é (cosmético)
 *   parcelas: number,         // 1 = à vista
 *   parcela: number|null,     // CENTAVOS por mês
 *   total: number,            // CENTAVOS, sempre preenchido
 *   noCartao: boolean|null,   // true/false quando a frase diz; null = não disse
 * }}
 */
function interpretarCompra(texto) {
  const bruto = String(texto || '').trim();
  if (!bruto) return null;

  const t = semAcento(bruto);

  // Passado/já feito nunca é pergunta — barra antes de qualquer coisa.
  if (BLOQUEIO.test(t)) return null;

  const temPermissao = PERMISSAO.test(t);
  const temAquisicao = AQUISICAO.test(t);
  const direta       = FORMA_DIRETA.test(t);
  if (!direta && !(temPermissao && temAquisicao)) return null;

  // ── Parcelas: "10x", "em 10 vezes", "em dez vezes", "parcelar em 6" ───────
  let parcelas = null;
  const mX = t.match(/\b(\d{1,2})\s*x\b/);
  const mVezes = t.match(/\b(?:em|de)\s+(\d{1,2})\s*(?:vezes|parcelas|meses)\b/);
  const mExtenso = t.match(new RegExp(
    '\\b(?:em|de)\\s+(' + Object.keys(PARCELAS_EXTENSO).join('|') + ')\\s*(?:vezes|parcelas|meses|x)\\b'));
  if (mX)            parcelas = parseInt(mX[1], 10);
  else if (mVezes)   parcelas = parseInt(mVezes[1], 10);
  else if (mExtenso) parcelas = PARCELAS_EXTENSO[mExtenso[1]];

  // Parcelamento de 0x/1x é à vista; acima de 48 é ruído (ano, CEP, etc.).
  if (parcelas != null && (parcelas < 2 || parcelas > 48)) parcelas = null;

  // ── Valores. Pega TODOS os números "de dinheiro" e decide quem é quem ────
  // ⚠️ O nº de parcelas já foi extraído acima e é removido daqui, senão o "10"
  // de "10x" viraria um valor de R$ 10 e bagunçaria a escolha.
  const semParcelas = t
    .replace(/\b\d{1,2}\s*x\b/g, ' ')
    .replace(/\b(?:em|de)\s+\d{1,2}\s*(?:vezes|parcelas|meses)\b/g, ' ');

  const numeros = [];
  const re = /(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g;
  let m;
  while ((m = re.exec(semParcelas)) !== null) {
    const v = numeroBr(m[1]);
    if (v != null && v > 0) numeros.push(v);
  }
  if (!numeros.length) return null;   // sem valor não há o que avaliar

  // O maior número é o valor de referência da frase. Em "10x de 500" sobrou só
  // o 500; em "3000 em 12x" sobrou o 3000.
  const valor = Math.max(...numeros);

  // ── O valor dito é a PARCELA ou o TOTAL? ─────────────────────────────────
  // ⚠️ Regra decisiva e a mais fácil de errar. "10x de 500" = R$ 5.000 no
  // total; ler como total daria R$ 50/mês e aprovaria qualquer coisa.
  // A marca é a preposição depois do "Nx": "10x DE 500" → parcela.
  // "3000 EM 10x" → total. Sem parcelamento, é sempre o total.
  let parcela = null;
  let total;
  if (!parcelas) {
    parcelas = 1;
    total = cent(valor);
  } else {
    // ⚠️ A quantidade pode vir em DÍGITO ("10x", "em 10 vezes") ou por EXTENSO
    // ("em dez vezes"). O teste precisa cobrir as duas: cobrindo só dígito,
    // "em dez vezes de 300" caía no ramo do total e devolvia R$ 300 no lugar
    // de R$ 3.000 — errando o valor da compra em 10 vezes.
    const QTD = '(?:\\d{1,2}|' + Object.keys(PARCELAS_EXTENSO).join('|') + ')';
    const VAL = '(?:r\\$)?\\s*[\\d.,]+';
    const ehParcela =
         new RegExp('\\b' + QTD + '\\s*x\\s*(?:de|a)\\s*' + VAL).test(t)
      || new RegExp('\\b(?:em|de)\\s+' + QTD + '\\s*(?:vezes|parcelas|meses)\\s+(?:de|a)\\s+' + VAL).test(t)
      || new RegExp('\\b(?:parcelas?|presta[cç][oõ]es?)\\s+de\\s+' + VAL).test(t);
    if (ehParcela) {
      parcela = cent(valor);
      total   = parcela * parcelas;
    } else {
      total   = cent(valor);
      parcela = Math.round(total / parcelas);
    }
  }
  if (parcela == null) parcela = Math.round(total / parcelas);

  // ── Meio de pagamento, quando a frase diz ────────────────────────────────
  // ⚠️ `null` (não disse) é DIFERENTE de `false` (disse que é à vista): com
  // null o handler decide pelo nº de parcelas, com false ele nem checa limite.
  let noCartao = null;
  if (/\b(?:no|com|pelo|de)\s*(?:cart[ao]o|credito|cr[ée]dito)\b/.test(t)) noCartao = true;
  else if (/\b(?:a\s+vista|no\s+(?:pix|debito|dinheiro)|em\s+dinheiro)\b/.test(t)) noCartao = false;

  return { item: extrairItem(bruto), parcelas, parcela, total, noCartao };
}

module.exports = { interpretarCompra, numeroBr, cent };
