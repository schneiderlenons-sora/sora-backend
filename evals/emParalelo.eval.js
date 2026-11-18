// =============================================================================
// EVAL — mapEmOrdem / memoPorRequisicao (src/services/emParalelo.js)
//
// O paralelismo das rotas de faturas e da agenda só é seguro se:
//   §1 a saída vier na ORDEM da entrada (a tela e a dedup da agenda dependem);
//   §2 o teto de simultâneos for respeitado;
//   §3 um erro parar o que ainda não começou e subir (como o laço em série);
//   §4 lista vazia/inválida não travar;
//   §5 o memo devolver a MESMA promessa pros mesmos argumentos.
//
// Rodar:  node evals/emParalelo.eval.js
// =============================================================================
const path = require('path');
const { mapEmOrdem, memoPorRequisicao } = require(path.join(__dirname, '../src/services/emParalelo'));

const falhas = [];
let casos = 0;
const eq = (a, b, m) => { casos++; if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push(`${m}\n   esperado ${JSON.stringify(b)}\n   veio     ${JSON.stringify(a)}`); };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // §1 ordem: o 1º demora mais que o último e mesmo assim vem primeiro.
  const atrasos = [60, 10, 40, 5, 25];
  const r1 = await mapEmOrdem(atrasos, 3, async (ms, i) => { await espera(ms); return `${i}:${ms}`; });
  eq(r1, ['0:60', '1:10', '2:40', '3:5', '4:25'], '§1 saída na ordem da entrada, não na de término');

  // §2 teto: nunca mais de 2 ao mesmo tempo; e com teto 1 é EM SÉRIE.
  let ativos = 0, pico = 0;
  await mapEmOrdem([1, 2, 3, 4, 5, 6], 2, async () => { ativos++; pico = Math.max(pico, ativos); await espera(15); ativos--; });
  eq(pico, 2, '§2 no máximo 2 simultâneos');
  const ordem = [];
  await mapEmOrdem(['a', 'b', 'c'], 1, async (x) => { ordem.push('ini ' + x); await espera(5); ordem.push('fim ' + x); });
  eq(ordem, ['ini a', 'fim a', 'ini b', 'fim b', 'ini c', 'fim c'], '§2 teto 1 = em série, como o laço antigo');
  // Teto maior que a lista não quebra.
  eq(await mapEmOrdem([1, 2], 10, async (x) => x * 2), [2, 4], '§2 teto maior que a lista');
  // Teto inválido vira 1.
  eq(await mapEmOrdem([1, 2], 0, async (x) => x), [1, 2], '§2 teto 0 vira 1');

  // §3 erro: sobe, e o que ainda não começou NÃO começa.
  const comecados = [];
  let erro = null;
  try {
    await mapEmOrdem([0, 1, 2, 3, 4, 5], 2, async (x) => {
      comecados.push(x);
      await espera(x === 1 ? 5 : 30);
      if (x === 1) throw new Error('falhou o 1');
      return x;
    });
  } catch (e) { erro = e.message; }
  await espera(80);
  eq(erro, 'falhou o 1', '§3 o erro sobe');
  eq(comecados.includes(4) || comecados.includes(5), false, '⚠️ §3 depois do erro nada novo começa (o laço em série também parava)');
  // Erro síncrono dentro da função também vira rejeição (não estoura fora).
  let erro2 = null;
  try { await mapEmOrdem([1], 2, () => { throw new Error('síncrono'); }); } catch (e) { erro2 = e.message; }
  eq(erro2, 'síncrono', '§3 erro síncrono vira rejeição');

  // §4 vazio / inválido.
  eq(await mapEmOrdem([], 3, async () => 1), [], '§4 lista vazia');
  eq(await mapEmOrdem(null, 3, async () => 1), [], '§4 null vira lista vazia');

  // §5 memo.
  let chamadas = 0;
  const ler = memoPorRequisicao(async (id, comp) => { chamadas++; await espera(10); return { id, comp, total: 7 }; });
  const [a, b, c] = await Promise.all([ler('x', '2026-11'), ler('x', '2026-11'), ler('y', '2026-11')]);
  eq(chamadas, 2, '§5 mesmos argumentos ao mesmo tempo = UMA leitura');
  eq(a === b, true, '§5 a mesma promessa/resultado pros mesmos argumentos');
  eq(c.id, 'y', '§5 argumentos diferentes = leitura própria');
  await ler('x', '2026-11');
  eq(chamadas, 2, '§5 pedir de novo depois não lê de novo');

  if (falhas.length) {
    console.log(`❌ ${falhas.length} de ${casos} casos falharam:\n - ` + falhas.join('\n - '));
    process.exit(1);
  }
  console.log(`✅ eval:em-paralelo — ${casos} casos`);
})();
