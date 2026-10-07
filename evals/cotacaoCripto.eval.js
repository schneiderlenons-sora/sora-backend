// =============================================================================
// EVAL — cotação de cripto, a cascata CoinGecko -> Mercado Bitcoin.
//
// ⚠️ POR QUE EXISTE: as 8 posições de cripto da base NUNCA atualizavam, e três
// exibiam número absurdo de uma atualização parcial antiga — Ethereum a
// R$ 0,45 com R$ 452,20 aportados, Bitcoin a R$ 2,31 com R$ 4.200. A CoinGecko
// recusa o IP do Render (429) igual ao Yahoo; o `catch` devolvia null, a rota
// fazia `continue`, e a tela seguia com o valor velho sem dizer nada.
//
// Rede FALSA aqui — o eval trava a TRADUÇÃO e a CASCATA, que é onde se erra:
// que símbolo mandar, qual fonte usar, e o que NUNCA pode virar preço.
//
// Rodar: node evals/cotacaoCripto.eval.js
// =============================================================================
const Module = require('module');

// ── axios falso (a CoinGecko) ───────────────────────────────────────────────
const gecko = { chamadas: [], resposta: null, lancar: null };
const carregarOriginal = Module._load;
Module._load = function (pedido) {
  if (pedido === 'axios') {
    return {
      get: async (url) => {
        gecko.chamadas.push(String(url));
        if (gecko.lancar) throw gecko.lancar;
        return { data: gecko.resposta };
      },
    };
  }
  if (pedido === 'yahoo-finance2') {
    class Falso { suppressNotices() {} async quote() { return null; } async search() { return { quotes: [] }; } async historical() { return []; } }
    return { default: Falso };
  }
  return carregarOriginal.apply(this, arguments);
};

const { buscarCotacaoCripto } = require('../src/services/cotacoes');
const { simboloCripto, precoDoTicker } = require('../src/services/cotacaoCripto');

// ── fetch falso (o Mercado Bitcoin) ─────────────────────────────────────────
const mb = { urls: [], status: 200, corpo: null, lancar: null };
global.fetch = async (url) => {
  mb.urls.push(String(url));
  if (mb.lancar) throw mb.lancar;
  return { ok: mb.status >= 200 && mb.status < 300, status: mb.status, json: async () => mb.corpo };
};

const zerar = () => {
  gecko.chamadas = []; gecko.lancar = null; gecko.resposta = null;
  mb.urls = []; mb.status = 200; mb.lancar = null;
  mb.corpo = { ticker: { last: '418969.00000000', open: '428048.00000000', high: '1', low: '1' } };
};

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const perto = (a, b, m) => { if (!(Math.abs(Number(a) - b) < 0.01)) falhas.push(`${m} (esperado ~${b}, veio ${JSON.stringify(a)})`); };
const ok = (c, m) => { if (!c) falhas.push(m); };

(async () => {

console.log('-- 1. o simbolo que a corretora espera --');
{
  // ⚠️ O ticker de cripto na base e o id da COINGECKO ("bitcoin"); a corretora
  // usa a SIGLA ("BTC"). Sem traduzir, toda chamada daria 404.
  eq(simboloCripto('bitcoin'), 'BTC', '1 bitcoin -> BTC');
  eq(simboloCripto('ethereum'), 'ETH', '1 ethereum -> ETH');
  eq(simboloCripto('pepe'), 'PEPE', '1 pepe -> PEPE');
  eq(simboloCripto('BITCOIN'), 'BTC', '1 caixa nao importa');
  // Palpite "ja e a sigla" — a base tem uma posicao gravada como "BTC".
  eq(simboloCripto('BTC'), 'BTC', '1 sigla passa igual');
  eq(simboloCripto('sol'), 'SOL', '1 sigla minuscula sobe');
  // ⚠️ E O QUE NAO TEM CARA DE SIGLA NAO VIRA CHAMADA DE API. O campo `nome`
  // da base tem coisas como "Bitcoin - NuBanck".
  eq(simboloCripto('Bitcoin - NuBanck'), '', '1 nome com espaco e recusado');
  eq(simboloCripto(''), '', '1 vazio');
  eq(simboloCripto(null), '', '1 null');
  eq(simboloCripto('   '), '', '1 so espaco');
  eq(simboloCripto('umnomemuitolongodemais'), '', '1 longo demais nao e sigla');
}
console.log('  ok');

console.log('-- 2. ler o ticker da corretora --');
{
  // `last` vem como STRING de 8 casas.
  const c = precoDoTicker({ ticker: { last: '418969.00000000', open: '428048.00000000' } });
  perto(c.precoAtual, 418969, '2 preco');
  eq(c.moeda, 'BRL', '2 real nativo, sem cambio');
  // ⚠️ A variacao do dia SAI DO `open` — a corretora nao manda o percentual
  // pronto, e cravar 0 esconderia a queda do dia na tela.
  perto(c.variacaoDia, ((418969 - 428048) / 428048) * 100, '2 variacao vem do open');

  // Sem `open` nao da pra calcular: 0 e o honesto, nao um palpite.
  eq(precoDoTicker({ ticker: { last: '100' } }).variacaoDia, 0, '2 sem open -> 0');
  eq(precoDoTicker({ ticker: { last: '100', open: '0' } }).variacaoDia, 0, '2 open 0 nao divide por zero');
}
console.log('  ok');

console.log('-- 3. resposta sem preco NAO vira zero --');
{
  // Zero iria direto pro patrimonio da pessoa como "nao vale nada".
  for (const lixo of [
    { ticker: {} }, { ticker: { last: null } }, { ticker: { last: '0' } },
    { ticker: { last: '-5' } }, { ticker: { last: 'abc' } }, {}, null, undefined,
  ]) {
    eq(precoDoTicker(lixo), null, `3 ${JSON.stringify(lixo)} -> null`);
  }
}
console.log('  ok');

console.log('-- 4. CoinGecko respondendo: nem toca na corretora --');
{
  zerar();
  gecko.resposta = { bitcoin: { brl: 417700, brl_24h_change: -2.0 } };
  const c = await buscarCotacaoCripto('bitcoin');
  perto(c.precoAtual, 417700, '4 preco da CoinGecko');
  perto(c.variacaoDia, -2.0, '4 variacao da CoinGecko');
  eq(buscarCotacaoCripto.ultimaFonte, 'coingecko', '4 fonte');
  eq(mb.urls.length, 0, '4 nao gastou chamada na corretora');
}
console.log('  ok');

console.log('-- 5. CoinGecko com 429 -> a corretora salva --');
{
  // ⚠️ ESTE E O CASO REAL DE PRODUCAO. Sem ele a aba fica com valor fossil.
  zerar();
  gecko.lancar = new Error('Request failed with status code 429');
  const c = await buscarCotacaoCripto('bitcoin');
  perto(c.precoAtual, 418969, '5 preco da corretora');
  eq(buscarCotacaoCripto.ultimaFonte, 'mercadobitcoin', '5 fonte');
  ok(mb.urls[0]?.includes('/BTC/ticker'), '5 pediu BTC, nao "bitcoin"');
}
console.log('  ok');

console.log('-- 6. CoinGecko que responde SEM o preco tambem cai pra proxima --');
{
  // ⚠️ Falha silenciosa e pior que excecao: a CoinGecko responde 200 com objeto
  // vazio pra id desconhecido, e antes isso virava `null` final.
  zerar();
  gecko.resposta = {};
  const c = await buscarCotacaoCripto('bitcoin');
  perto(c?.precoAtual, 418969, '6 corretora assumiu');
  eq(buscarCotacaoCripto.ultimaFonte, 'mercadobitcoin', '6 fonte');

  zerar();
  gecko.resposta = { bitcoin: { brl: null } };
  eq((await buscarCotacaoCripto('bitcoin'))?.precoAtual, 418969, '6 brl null tambem cai');

  // ⚠️ E PRECO ZERO NAO VALE como resposta — era o jeito de uma fonte ruim
  // zerar o patrimonio de alguem.
  zerar();
  gecko.resposta = { bitcoin: { brl: 0 } };
  eq((await buscarCotacaoCripto('bitcoin'))?.precoAtual, 418969, '6 brl 0 nao vale');
}
console.log('  ok');

console.log('-- 7. as DUAS fontes falhando -> null, nunca um numero --');
{
  zerar();
  gecko.lancar = new Error('429');
  mb.status = 404;
  mb.corpo = { code: 'API|COIN_NOT_FOUND' };
  const c = await buscarCotacaoCripto('moedaquenaoexiste');
  eq(c, null, '7 null');
  eq(buscarCotacaoCripto.ultimaFonte, null, '7 sem fonte');
}
console.log('  ok');

console.log('-- 8. rede caindo na corretora nao estoura --');
{
  zerar();
  gecko.lancar = new Error('429');
  mb.lancar = new Error('ECONNRESET');
  eq(await buscarCotacaoCripto('bitcoin'), null, '8 devolve null, nao explode');
}
console.log('  ok');

console.log('-- 9. ticker invalido nao gera chamada de API --');
{
  zerar();
  gecko.lancar = new Error('429');
  await buscarCotacaoCripto('Bitcoin - NuBanck');
  eq(mb.urls.length, 0, '9 nome com espaco nao viu a rede');
}
console.log('  ok');

console.log('-- 10. resposta de ERRO nao pode virar preco --');
{
  const { cotacaoCriptoMB } = require('../src/services/cotacaoCripto');

  // ⚠️ 404 E RESPOSTA, nao falha: a corretora diz COIN_NOT_FOUND pra moeda
  // que ela nao lista. O motivo distingue "nao existe la" de "quebrou", e e o
  // que impede o chamador de tentar pra sempre uma moeda que nunca vai vir.
  zerar();
  mb.status = 404;
  mb.corpo = { code: 'API|COIN_NOT_FOUND', message: 'This coin not found' };
  eq(await cotacaoCriptoMB('bitcoin'), null, '10 404 -> null');
  eq(cotacaoCriptoMB.ultimoErro, 'nao_listada', '10 motivo = nao_listada');

  // ⚠️ O CASO QUE A GUARDA DE `resp.ok` REALMENTE EVITA: corpo com cara de
  // ticker valido vindo com status de ERRO. Sem a guarda, um 500 da corretora
  // (ou uma pagina de manutencao com JSON em cache) viraria PRECO na carteira
  // da pessoa.
  zerar();
  mb.status = 500;
  mb.corpo = { ticker: { last: '999999.00000000', open: '1.00000000' } };
  eq(await cotacaoCriptoMB('bitcoin'), null, '10 500 com corpo valido -> null');
  eq(cotacaoCriptoMB.ultimoErro, 'HTTP 500', '10 motivo diz o status');

  // E 200 com corpo sem preco e "sem_preco", nem 404 nem HTTP.
  zerar();
  mb.corpo = { ticker: {} };
  eq(await cotacaoCriptoMB('bitcoin'), null, '10 200 sem preco -> null');
  eq(cotacaoCriptoMB.ultimoErro, 'sem_preco', '10 motivo = sem_preco');
}
console.log('  ok');
console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  .', f));
  process.exit(1);
}
console.log('OK cotacaoCripto: traduz a sigla, cai pra corretora no 429, e nunca inventa preco');
process.exit(0);
})();
