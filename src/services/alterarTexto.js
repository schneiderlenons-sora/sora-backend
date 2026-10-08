// =============================================================================
// "ALTERA A TRANSAÇÃO ab12cd PRA 50" — o parser, sem IA.
//
// Pedido de cliente (Fábio, 05/10/2026): *"a possibilidade de ALTERAR o
// lançamento, e não só a de exclusão"*.
//
// ⚠️ GATILHO ESTREITO, E ISSO É O PONTO. Os verbos daqui (altera/muda/corrige/
// edita/troca/ajusta) são os mais comuns do idioma, e o projeto já pagou caro
// por duas regras amplas demais — a de "gasto" e a de "relatório", que
// sequestravam qualquer frase com a palavra. Aqui a frase só é reivindicada
// quando aponta para UMA transação: um id curto, ou a palavra
// transação/lançamento junto de "última". Sem alvo → `null` → a frase segue
// seu caminho normal e, no fim, a IA.
//
// ⚠️ MEDIDO ANTES DE ESCREVER (interpretador atual, 07/10/2026): das 8 frases
// de alteração, 7 caíam na IA e UMA era sequestrada —
// `"corrige o último lançamento para 80"` virava
// `{acao:'alterar_saldo', nome:'último lançamento', valor:80}`, ou seja, a Sora
// tentava acertar o saldo de uma conta chamada "último lançamento". Por isso
// este detector roda ANTES da regra de saldo.
// =============================================================================

/** Tira acento e baixa a caixa — o resto do arquivo casa no texto cru. */
function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Verbos que abrem uma alteração. "ajusta/ajustar" entram, mas a guarda de
// alvo é quem impede a colisão com "ajustar nubank 850" (que é saldo).
const VERBO = '(?:altera(?:r)?|muda(?:r)?|corrig[ei](?:r)?|edita(?:r)?|troca(?:r)?|ajusta(?:r)?|conserta(?:r)?|arruma(?:r)?)';

// Como a pessoa chama a linha.
const ALVO = '(?:transacao|transacoes|lancamento|lancamentos|gasto|compra|despesa|receita|recebimento|registro)';

/**
 * Qual transação? `{ idCurto }` ou `{ ultima: true }`, ou `null`.
 *
 * ⚠️ O id tem 6 alfanuméricos (mesmo formato do `apagar`), e pegamos o ÚLTIMO
 * da frase — é onde ele fica. Pegar o primeiro capturaria pedaços do próprio
 * comando ("altera" tem 6 letras).
 */
function alvoDaFrase(t) {
  if (/\bultim[oa]/.test(t)) return { ultima: true, idCurto: null };

  // ⚠️ NÃO pode casar palavra comum de 6 letras. Um id curto é gerado com
  // letras E dígitos misturados; exigir pelo menos um dígito tira "mercado",
  // "padaria", "cartao", "nubank" e companhia do caminho.
  const candidatos = (t.match(/\b[a-z0-9]{6}\b/g) || [])
    .filter((p) => /\d/.test(p) && /[a-z]/.test(p));
  if (candidatos.length) return { ultima: false, idCurto: candidatos[candidatos.length - 1].toUpperCase() };

  return null;
}

/** Valor em reais escrito na frase ("pra 50", "para R$ 1.250,00"). */
function parseValorBR(txt) {
  const n = String(txt).replace(/\./g, '').replace(',', '.');
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * O que a pessoa quer mudar.
 *
 * Lê a frase ORIGINAL (com acento e caixa) pra devolver a descrição e a
 * categoria **como ela escreveu** — é a sugestão 003 do mesmo cliente
 * ("Corrida de Uber", não "corrida de uber"). As buscas acontecem no texto
 * normalizado e o recorte sai do original, pelo índice.
 */
function mudancasDaFrase(original) {
  const t = semAcento(original);
  const out = {};

  // Recorta do ORIGINAL o que o regex achou no normalizado (mesmos índices:
  // `semAcento` não muda o comprimento — NFD+remoção de marcas devolve 1:1
  // para o alfabeto latino que usamos).
  const recorte = (m, grupo) => {
    if (!m) return null;
    const ini = m.index + m[0].indexOf(m[grupo]);
    return original.slice(ini, ini + m[grupo].length).trim().replace(/[.,;]+$/, '');
  };

  let m;

  // DESCRIÇÃO — "descricao corrida de uber", "descr: X", "nome X"
  if ((m = t.match(/\b(?:descricao|descr|nome|titulo)\s*:?\s+(.+?)\s*$/))) {
    const v = recorte(m, 1);
    if (v) out.descricao = v;
  }

  // CATEGORIA — "categoria mercado"
  if ((m = t.match(/\bcategoria\s*:?\s+(.+?)\s*$/))) {
    const v = recorte(m, 1);
    if (v) out.categoria = v;
  }

  // CONTA — "conta nubank", "pra conta nubank", "pro nubank"
  if ((m = t.match(/\b(?:para|pra|pro|de|da|do)?\s*conta\s*:?\s+(.+?)\s*$/))) {
    const v = recorte(m, 1);
    if (v) out.conta = v;
  }

  // DATA — "data 05/10", "data 05/10/2026"
  if ((m = t.match(/\bdata\s*:?\s+(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/))) {
    const dia = Number(m[1]);
    const mes = Number(m[2]);
    if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) {
      const hoje = new Date();
      let ano = m[3] ? Number(m[3]) : hoje.getFullYear();
      if (ano < 100) ano += 2000;
      out.data = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    }
  }

  // TIPO — "pra receita", "vira gasto"
  if (/\b(?:para|pra|vira|virou|e)\s+(?:uma?\s+)?(?:receita|recebimento|entrada)\b/.test(t)) out.tipo = 'Recebimento';
  else if (/\b(?:para|pra|vira|virou|e)\s+(?:um\s+)?(?:gasto|despesa|saida)\b/.test(t)) out.tipo = 'Gasto';

  // VALOR — "pra 50", "para R$ 1.250,00", "valor 80".
  //
  // ⚠️ DOIS PADRÕES, COM REGRAS DIFERENTES — e foi a MUTAÇÃO que mostrou
  // por quê.
  //
  // "valor 80" é EXPLÍCITO: a pessoa nomeou o campo, então sempre vale e
  // convive com outro campo na mesma frase. A primeira versão bloqueava
  // isso, e "altera ab12cd valor 80 categoria Mercado" perdia o 80 EM
  // SILÊNCIO — mudava só a categoria e confirmava como se tivesse feito as
  // duas coisas.
  //
  // Já "para 50" no FIM é implícito, e só vale quando nenhum campo nomeado
  // já levou o fim da frase: em "altera ab12cd categoria 123" o 123 é o
  // NOME da categoria, não um valor.
  let mv = t.match(/\bvalor\s*:?\s*(?:de\s+|para\s+|pra\s+)?(?:r\$\s*)?(\d[\d.,]*)/);
  if (!mv && !(out.descricao || out.categoria || out.conta)) {
    mv = t.match(/\b(?:para|pra|por|=)\s*(?:r\$\s*)?(\d[\d.,]*)\s*$/);
  }
  if (mv) {
    const v = parseValorBR(mv[1]);
    if (v !== null) out.valor = v;
  }

  return out;
}

/**
 * A frase é um pedido de alterar transação?
 *
 * @returns {{acao:'alterar_tx', idCurto:string|null, ultima:boolean, mudancas:Object}|null}
 */
function detectarAlteracao(original) {
  const t = semAcento(original);

  // 1. Precisa de um VERBO de edição no começo da frase ou logo depois de um
  //    "quero/preciso/pode". Verbo no meio da frase quase sempre é outra coisa
  //    ("o mercado mudou de nome").
  if (!new RegExp(`^\\s*(?:(?:eu\\s+)?(?:quero|queria|preciso|pode|poderia|gostaria\\s+de|da\\s+pra|consigo)\\s+)?${VERBO}\\b`).test(t)) {
    return null;
  }

  // 2. ⚠️ GUARDAS — as frases que usam o MESMO verbo e não são isto.
  //    Cada uma tem regra própria no interpretador, e todas respondem antes OU
  //    depois daqui; o que não pode é esta regra roubá-las no meio.
  if (/\b(?:plano|assinatura|mensalidade|senha|email|e-mail|telefone|numero|perfil|nome\s+d[ao]\s+(?:conta|cartao|grupo))\b/.test(t)) return null;
  if (/\bsaldo\b/.test(t)) return null;                       // "ajusta o saldo do inter pra 300"
  if (/\b(?:vencimento|fechamento|limite)\b/.test(t)) return null; // datas/limite do cartão
  if (/\b(?:meta|divida|dívida|recorrenc|conta\s+fixa|lembrete|investimento)\b/.test(t)) return null;

  // 3. Precisa apontar UMA transação.
  const alvo = alvoDaFrase(t);
  if (!alvo) return null;

  // ⚠️ "última" sozinha não basta: "altera a última" pode ser conta, meta,
  //    dívida… Exige a palavra que nomeia a linha. Com ID explícito não
  //    precisa — o id só existe em transação.
  if (alvo.ultima && !new RegExp(`\\b${ALVO}\\b`).test(t)) return null;

  return { acao: 'alterar_tx', idCurto: alvo.idCurto, ultima: alvo.ultima, mudancas: mudancasDaFrase(original) };
}

module.exports = { detectarAlteracao, mudancasDaFrase, alvoDaFrase, semAcento };
