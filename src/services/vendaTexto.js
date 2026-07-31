// =============================================================================
// "vendi 3 bolos por 90 pra dona Maria" → venda registrada.
//
// LOCAL-FIRST, sem IA (convenção do projeto): quem está atendendo no balcão não
// espera 3 segundos por uma resposta da OpenAI, e o dono manda essa frase dez
// vezes por dia. Regex resolve em microssegundos e nunca fica fora do ar.
//
// A frase é ambígua por natureza — "vendi 3 bolos 90" pode ser 90 no total ou
// 90 cada. A regra: **o valor dito é sempre o TOTAL**, porque é assim que a
// pessoa fala ("vendi noventa reais de bolo"). Quem quiser o unitário usa
// "cada": "vendi 3 bolos a 30 cada".
//
// Este arquivo só INTERPRETA. Casar com produto/cliente de verdade e gravar é
// da rota — separado pra poder ter eval (evals/vendaTexto.eval.js).
// =============================================================================

const GATILHO = /\b(vendi|vendemos|venda\s+de|vendida?s?)\b/i;

/** "1,5" e "1.5" viram 1.5; "1.500,50" vira 1500.5 (formato BR). */
function numeroBr(txt) {
  if (!txt) return null;
  let s = String(txt).trim().replace(/\s/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/(?<=\d)\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

const POR_EXTENSO = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, 'três': 3, quatro: 4, cinco: 5,
  seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
  meia: 0.5, meio: 0.5,
};

const RUIDO_PRODUTO = /^(de|do|da|dos|das|uns|umas|um|uma|o|a|os|as)\s+/i;

/**
 * Interpreta uma frase de venda.
 * @returns {null|{quantidade, produto, valor, unitario, cliente, forma, aPrazo}}
 *          `valor` em CENTAVOS (null quando a frase não disse o preço — aí a
 *          rota usa o preço de tabela do produto).
 */
function interpretarVenda(texto) {
  const t = String(texto || '').trim();
  if (!t || !GATILHO.test(t)) return null;

  // Pergunta não é lançamento. "quanto vendi esse mês?" tem o gatilho e não é
  // uma venda — registrar aqui criaria movimentação do nada.
  if (/\?/.test(t) || /^\s*(quanto|quantos|quantas|quando|quem|qual|quais|como|onde|o\s+que)\b/i.test(t)) {
    return null;
  }

  let resto = t.replace(/^.*?\b(vendi|vendemos|venda\s+de|vendidas?|vendido)\b\s*/i, '');
  if (!resto) return null;

  // ── Cliente: "pra/para/pro + nome" (até o fim ou até outra preposição) ────
  // O terminador vai em LOOKAHEAD: se entrasse no match, remover o trecho
  // levaria junto o "por" da frase e o preço sumiria ("pra Maria por 40").
  let cliente = null;
  const mCliente = resto.match(/\b(?:pra|para|pro|p\/)\s+(?:o\s+|a\s+)?([a-zà-ú][a-zà-ú\s'.]{1,40}?)(?=\s+(?:por|no|na|em|a|de)\s|[,.!?]|$)/i);
  if (mCliente) {
    cliente = mCliente[1].trim().replace(/\s+/g, ' ');
    resto = resto.replace(mCliente[0], ' ');
  }

  // ── Forma de pagamento ───────────────────────────────────────────────────
  let forma = null, aPrazo = false;
  if (/\bpix\b/i.test(resto)) forma = 'pix';
  else if (/\bdin?heiro\b|\bespécie\b|\bespecie\b/i.test(resto)) forma = 'dinheiro';
  else if (/\bcr[eé]dito\b/i.test(resto)) forma = 'credito';
  else if (/\bd[eé]bito\b|\bcart[aã]o\b/i.test(resto)) forma = 'debito';
  // Fiado é a venda a prazo do comércio de bairro — precisa virar conta a
  // receber, não entrada no caixa, senão o saldo do dia mente.
  if (/\bfiado\b|\ba\s+prazo\b|\banotad[oa]\b|\bpendura\b/i.test(resto)) {
    aPrazo = true; forma = forma || null;
  }
  resto = resto.replace(/\b(no|em|por|via)?\s*(pix|dinheiro|cr[eé]dito|d[eé]bito|cart[aã]o|fiado|a\s+prazo)\b/gi, ' ');

  // ── Valor: "por 90", "90 reais", "R$ 90" ─────────────────────────────────
  let valor = null, unitario = false;
  const mValor =
       resto.match(/\b(?:por|a)\s*r?\$?\s*([\d.,]+)\s*(?:reais|r\$|conto?s?)?\s*(cada|a\s+unidade|un)?/i)
    || resto.match(/\br\$\s*([\d.,]+)\s*(cada)?/i)
    || resto.match(/\b([\d.,]+)\s*(?:reais|conto?s?|pila)\b\s*(cada)?/i);
  if (mValor) {
    const n = numeroBr(mValor[1]);
    if (n != null && n > 0) {
      valor = Math.round(n * 100);
      unitario = !!mValor[2];
      resto = resto.replace(mValor[0], ' ');
    }
  }

  // Número solto no FIM ("vendi 2 pizzas 50") é o preço. É como se fala no
  // balcão, e sem isso o "50" acabava colado no nome do produto.
  if (valor == null) {
    const mFim = resto.match(/\s([\d.,]+)\s*$/);
    if (mFim) {
      const n = numeroBr(mFim[1]);
      if (n != null && n > 0) { valor = Math.round(n * 100); resto = resto.replace(mFim[0], ' '); }
    }
  }

  // ── Quantidade: número ou palavra no começo do que sobrou ────────────────
  let quantidade = 1;
  let qtdExplicita = false;
  const mQtd = resto.match(/^\s*([\d.,]+)\s*(?:un|unidades?|kg|kilos?|quilos?|pe[çc]as?|caixas?)?\s+/i);
  if (mQtd) {
    const n = numeroBr(mQtd[1]);
    if (n != null && n > 0) { quantidade = n; qtdExplicita = true; resto = resto.replace(mQtd[0], ' '); }
  } else {
    const mExt = resto.match(/^\s*([a-zà-ú]+)\s+/i);
    const chave = mExt && mExt[1].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (chave && POR_EXTENSO[chave] !== undefined) {
      quantidade = POR_EXTENSO[chave];
      qtdExplicita = true;
      resto = resto.replace(mExt[0], ' ');
    }
  }

  // ── Produto: o que sobrou ────────────────────────────────────────────────
  let produto = resto.replace(/\s+/g, ' ').trim()
    .replace(RUIDO_PRODUTO, '')
    .replace(/[,.!?;]+$/, '')
    .trim();
  if (produto.length < 2) produto = null;

  // Sem valor E sem quantidade não é venda registrável — é conversa ("vendi
  // bem hoje", "vendi pouco"). Registrar isso criaria movimentação do nada.
  if (valor == null && !qtdExplicita) return null;

  // "vendi 3 bolos a 30 cada" → total 90. O resto do sistema só entende total.
  const total = (valor != null && unitario) ? Math.round(valor * quantidade) : valor;

  return {
    quantidade,
    produto,
    valor: total,
    valor_unitario: unitario ? valor : null,
    cliente,
    forma,
    aPrazo,
  };
}

module.exports = { interpretarVenda, numeroBr };
