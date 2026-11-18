// =============================================================================
// Processar uma lista em PARALELO, com teto, sem mudar o resultado.
//
// Existe porque o gargalo das rotas lentas era IDA AO BANCO EM SÉRIE, não
// cálculo — medido em produção (Ohio, nov/2026, Server-Timing): a rota de
// faturas fazia 27 idas, 21 em série, e cada uma custa ~20–25 ms mesmo com o
// banco na mesma região. O laço `for (const c of cartoes) { await ... }`
// esperava um cartão inteiro antes de começar o próximo.
//
// Garantias (travadas em evals/emParalelo.eval.js):
//   • a saída vem NA ORDEM DA ENTRADA, não na ordem em que terminou;
//   • no máximo `limite` itens rodando ao mesmo tempo (o backend é o plano
//     gratuito do Render, e o banco sente rajada);
//   • se um item falhar, NADA NOVO COMEÇA e o erro sobe — o mesmo que o laço
//     em série fazia ao estourar no meio (os cartões seguintes nem rodavam).
// =============================================================================

/**
 * @template T, R
 * @param {T[]} lista
 * @param {number} limite  quantos ao mesmo tempo (>= 1)
 * @param {(item: T, i: number) => Promise<R>} fn
 * @returns {Promise<R[]>} na ordem de `lista`
 */
function mapEmOrdem(lista, limite, fn) {
  const itens = Array.isArray(lista) ? lista : [];
  const n = itens.length;
  if (!n) return Promise.resolve([]);
  const teto = Math.max(1, Math.min(Number(limite) || 1, n));
  const saida = new Array(n);
  let proximo = 0;
  let falhou = false;
  return new Promise((resolve, reject) => {
    let ativos = 0;
    let terminados = 0;
    const lancar = () => {
      while (!falhou && ativos < teto && proximo < n) {
        const i = proximo++;
        ativos++;
        Promise.resolve()
          .then(() => fn(itens[i], i))
          .then((r) => {
            saida[i] = r;
            ativos--; terminados++;
            if (falhou) return;
            if (terminados === n) resolve(saida);
            else lancar();
          }, (err) => {
            ativos--;
            if (falhou) return;
            falhou = true;
            reject(err);
          });
      }
    };
    lancar();
  });
}

/**
 * Memoriza uma função assíncrona POR ARGUMENTOS dentro de UMA requisição:
 * duas partes do mesmo cálculo pedindo a mesma leitura (ex.: as parcelas
 * previstas do mesmo cartão e competência) recebem a MESMA promessa — inclusive
 * se pedirem ao mesmo tempo. ⚠️ Só pra leitura cujo resultado ninguém altera.
 */
function memoPorRequisicao(fn) {
  const cache = new Map();
  return (...args) => {
    const k = JSON.stringify(args);
    if (!cache.has(k)) cache.set(k, Promise.resolve().then(() => fn(...args)));
    return cache.get(k);
  };
}

module.exports = { mapEmOrdem, memoPorRequisicao };
