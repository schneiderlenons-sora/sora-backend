// =============================================================================
// A DESCRIÇÃO DO LANÇAMENTO — como gravar e como mostrar.
//
// Duas sugestões do mesmo cliente (Fábio, 05/10/2026):
//
//   002 — "na mensagem do WhatsApp, também aparecer a DESCRIÇÃO do registro,
//          e não somente a categoria"
//   003 — "o texto da descrição começar em letra maiúscula, por exemplo
//          'Corrida de Uber' e não 'corrida de uber', ou seja ficar igual à
//          forma que o usuário lançou na mensagem"
//
// ⚠️ A 003 NÃO É "CAPITALIZAR A PRIMEIRA LETRA". Capitalizar daria "Corrida de
// uber" — o exemplo do cliente tem DUAS maiúsculas, e ele mesmo diz o
// critério: *"igual à forma que o usuário lançou"*. O que a Sora fazia era
// MINUSCULIZAR: `interpretarRapido` começa com `message.toLowerCase()` (dezenas
// de regexes dependem disso) e a descrição é uma fatia desse texto. Medido:
// "Gastei 25 com Corrida de Uber" gravava `corrida de uber`.
//
// Então a regra é RECUPERAR o trecho original, e só capitalizar a inicial
// quando a pessoa escreveu tudo em minúsculas de verdade.
// =============================================================================

/** Sem acento e em minúsculas — só para COMPARAR, nunca para gravar. */
function chave(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Primeira letra maiúscula, o resto intacto. */
function inicialMaiuscula(s) {
  const t = String(s || '');
  if (!t) return t;
  return t[0].toLocaleUpperCase('pt-BR') + t.slice(1);
}

/**
 * A descrição com a grafia que a pessoa escreveu.
 *
 * Procura o trecho (ignorando acento e caixa) dentro da mensagem original e
 * devolve a fatia ORIGINAL. Não achando, devolve o trecho como veio — com a
 * inicial maiúscula.
 *
 * ⚠️ NEM SEMPRE A DESCRIÇÃO VEM DO TEXTO. A IA às vezes resume ("50 no zé
 * delivery" → observação "bebida") e aí não há o que recuperar; a inicial
 * maiúscula é o que resta, e já é o que o cliente pediu nesse caso.
 *
 * ⚠️ A BUSCA É POR CHAVE, não por `toLowerCase()` simples: a descrição sai do
 * texto JÁ normalizado pelo interpretador, que remove acentos. Procurar
 * "refeicao" num original que diz "refeição" falharia sem isso.
 *
 * @param {string} descricao  o que o interpretador/IA extraiu (minúsculo)
 * @param {string} original   a mensagem como a pessoa escreveu
 */
function grafiaOriginal(descricao, original) {
  const d = String(descricao || '').trim();
  if (!d) return '';

  const texto = String(original || '');
  const alvo = chave(d);
  const base = chave(texto);

  // ⚠️ `chave` preserva o comprimento para o alfabeto latino (NFD separa a
  // marca, e a remoção devolve 1 caractere por letra), então o índice achado
  // no normalizado vale no original. Se por algum motivo não valer, o trecho
  // recortado não bate com o alvo e caímos no fallback.
  if (alvo && base.length === texto.length) {
    const i = base.indexOf(alvo);
    if (i >= 0) {
      const fatia = texto.slice(i, i + d.length);
      if (chave(fatia) === alvo) return inicialMaiuscula(fatia);
    }
  }

  return inicialMaiuscula(d);
}

/**
 * A linha "Descrição: X" da confirmação — ou `null` quando não vale mostrar.
 *
 * ⚠️ NÃO REPETE A CATEGORIA. Em "uber 18" a descrição extraída é "uber" e a
 * categoria é "Uber": mostrar as duas enche a confirmação de uma linha que não
 * informa nada, e foi justamente o excesso de linha redundante que fez a
 * confirmação ficar comprida.
 *
 * @param {string} descricao
 * @param {string} categoria  pode vir com emoji ("🍔 Alimentação")
 */
function linhaDescricao(descricao, categoria) {
  const d = String(descricao || '').trim();
  if (!d) return null;

  // A categoria pode trazer emoji e espaço; comparamos só as letras.
  const soLetras = (s) => chave(s).replace(/[^a-z0-9]+/g, ' ').trim();
  if (soLetras(d) === soLetras(categoria)) return null;

  return `📝 Descrição: ${d}`;
}

module.exports = { grafiaOriginal, linhaDescricao, inicialMaiuscula, chave };
