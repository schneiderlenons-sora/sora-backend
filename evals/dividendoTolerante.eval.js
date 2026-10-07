// =============================================================================
// EVAL — dividendo: "nao consegui ler" NAO e "nao pagou".
//
// ⚠️ ACHADO AO VERIFICAR a correcao da cotacao, conferindo o cron linha por
// linha. `buscarDividendos` devolvia 0 nos DOIS casos — provedor fora do ar e
// papel que de fato nao paga provento. E quem chama GRAVA o resultado. Ou seja:
// com o Yahoo recusando o IP (que e o estado de hoje), o `/atualizar-precos` e
// o cron das 03:00 APAGARIAM o historico de proventos de todo mundo.
//
// Hoje nenhuma linha da base tem dividendo > 0, entao o estrago ainda nao
// aconteceu — e e exatamente por isso que isto precisa de teste: e uma bomba
// armada, nao um bug visivel. Mesma regra do `patchDoSaldo`: calar nao e apagar.
//
// Rodar: node evals/dividendoTolerante.eval.js
// =============================================================================
const Module = require('module');

const yahoo = { historicos: [], erro: null, resposta: [] };
const carregarOriginal = Module._load;
Module._load = function (pedido) {
  if (pedido === 'yahoo-finance2') {
    class Falso {
      suppressNotices() {}
      async quote() { return null; }
      async search() { return { quotes: [] }; }
      async historical(t) {
        yahoo.historicos.push(t);
        if (yahoo.erro) throw yahoo.erro;
        return yahoo.resposta;
      }
    }
    return { default: Falso };
  }
  return carregarOriginal.apply(this, arguments);
};

const { buscarDividendos, _zerarDisjuntor, marcarYahooBloqueado } = require('../src/services/cotacoes');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

(async () => {

console.log('-- 1. historico VAZIO e 0: o papel nao pagou --');
{
  _zerarDisjuntor();
  yahoo.erro = null; yahoo.resposta = [];
  eq(await buscarDividendos('PETR4.SA'), 0, '1 lista vazia -> 0');
  // ⚠️ Tem de ser 0 e NAO null: zero aqui e informacao de verdade ("nao pagou"),
  // e virar null faria a tela manter um valor velho que nao existe mais.
}
console.log('  ok');

console.log('-- 2. historico COM provento soma --');
{
  _zerarDisjuntor();
  yahoo.resposta = [{ dividends: 1.5 }, { dividends: 0.75 }, { dividends: 0 }];
  eq(await buscarDividendos('PETR4.SA'), 2.25, '2 soma os proventos');
}
console.log('  ok');

console.log('-- 3. PORTA FECHADA devolve null, nao 0 --');
{
  // ⚠️ ESTE E O CASO DE PRODUCAO HOJE: o Yahoo recusa o IP do Render, o
  // disjuntor fecha, e o dividendo nem e consultado. Devolver 0 aqui faria o
  // chamador GRAVAR 0 em cima do historico do cliente.
  _zerarDisjuntor();
  marcarYahooBloqueado('teste');
  yahoo.historicos = [];
  eq(await buscarDividendos('PETR4.SA'), null, '3 porta fechada -> null');
  eq(yahoo.historicos.length, 0, '3 e nem gastou a chamada');
}
console.log('  ok');

console.log('-- 4. FALHA de leitura devolve null, nao 0 --');
{
  _zerarDisjuntor();
  yahoo.erro = new Error('socket hang up');
  eq(await buscarDividendos('PETR4.SA'), null, '4 erro de rede -> null');

  _zerarDisjuntor();
  yahoo.erro = new Error('Failed to get crumb, status 429');
  eq(await buscarDividendos('PETR4.SA'), null, '4 bloqueio -> null');
}
console.log('  ok');

console.log('-- 5. a REGRA de quem grava: null mantem, numero sobrescreve --');
{
  // A aritmetica que a rota e o cron aplicam, isolada. Os dois tinham a MESMA
  // linha errada — `(porAcao || 0)` — entao o teste e da regra, nao do arquivo.
  const decidir = (porAcao, jaGravado, fator, qtd) => (
    porAcao == null ? (jaGravado || 0) : porAcao * fator * qtd
  );

  eq(decidir(null, 120.5, 1, 10), 120.5, '5 null MANTEM o que estava gravado');
  eq(decidir(null, 0, 1, 10), 0, '5 null sem historico anterior fica 0');
  eq(decidir(0, 120.5, 1, 10), 0, '5 zero DE VERDADE sobrescreve (nao pagou)');
  eq(decidir(1.5, 120.5, 1, 10), 15, '5 provento novo sobrescreve');
  eq(decidir(2, 0, 5.4, 10), 108, '5 aplica cambio e quantidade');

  // ⚠️ A ARMADILHA: `porAcao || 0` trata null e 0 igual. Se alguem reescrever
  // assim, o null volta a apagar o historico.
  const errado = (porAcao, jaGravado, fator, qtd) => (porAcao || 0) * fator * qtd;
  eq(errado(null, 120.5, 1, 10), 0, '5 (a forma ERRADA zera — e o que isto impede)');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  .', f));
  process.exit(1);
}
console.log('OK dividendoTolerante: provedor fora do ar nao apaga provento do cliente');
process.exit(0);
})();
