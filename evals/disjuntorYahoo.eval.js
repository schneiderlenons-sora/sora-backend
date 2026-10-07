// =============================================================================
// EVAL — o DISJUNTOR do Yahoo.
//
// ⚠️ POR QUE ELE EXISTE: com a cotação voltando pela brapi, o botão "Atualizar
// cotações" do maior grupo da base (44 posições) faria ~7,5s de brapi MAIS
// ~15,4s de chamadas de dividendo ao Yahoo, TODAS recusadas — 23s de espera com
// mais da metade no lixo. O Yahoo é chamado em QUATRO lugares (cotação de ativo
// de fora da B3, dividendos, busca e câmbio) e nenhum sabia do bloqueio que o
// outro já tinha descoberto.
//
// Disjuntor é estado de MÓDULO, que é justamente o tipo de coisa que passa sem
// teste. Aqui se prova que ele: fecha com o primeiro 429, é compartilhado pelos
// quatro, se cura sozinho, NÃO contamina a brapi e NÃO vira "este ativo não tem
// cotação".
//
// Rodar: node evals/disjuntorYahoo.eval.js
// =============================================================================
const Module = require('module');

// ── Yahoo falso ─────────────────────────────────────────────────────────────
const yahoo = { quotes: [], buscas: [], historicos: [], erro: null, resposta: null };
const carregarOriginal = Module._load;
Module._load = function (pedido) {
  if (pedido === 'yahoo-finance2') {
    class Falso {
      suppressNotices() {}
      async quote(t) {
        yahoo.quotes.push(t);
        if (yahoo.erro) throw yahoo.erro;
        return yahoo.resposta;
      }
      async search(q) {
        yahoo.buscas.push(q);
        if (yahoo.erro) throw yahoo.erro;
        return { quotes: [{ symbol: 'DO.YAHOO', longname: 'achou' }] };
      }
      async historical(t) {
        yahoo.historicos.push(t);
        if (yahoo.erro) throw yahoo.erro;
        return [{ dividends: 1.5 }];
      }
    }
    return { default: Falso };
  }
  return carregarOriginal.apply(this, arguments);
};

const cot = require('../src/services/cotacoes');
const {
  buscarCotacaoAcao, buscarDividendos, buscarTickers, taxaParaBRLDetalhe,
  yahooRecusando, marcarYahooBloqueado, JANELA_BLOQUEIO_MS, _zerarDisjuntor,
} = cot;

// ── brapi / HTTP falso ──────────────────────────────────────────────────────
const http = { urls: [], brapi: null, status: 200, cambio: 5.4 };
global.fetch = async (url) => {
  const u = String(url);
  http.urls.push(u);
  if (u.includes('brapi.dev')) {
    return { ok: http.status < 300, status: http.status, json: async () => http.brapi, text: async () => '' };
  }
  // AwesomeAPI / er-api (as fontes 2 e 3 do câmbio)
  if (u.includes('awesomeapi')) {
    return { ok: true, status: 200, json: async () => ({ USDBRL: { bid: String(http.cambio) } }), text: async () => '' };
  }
  return { ok: true, status: 200, json: async () => ({ result: 'success', rates: { BRL: http.cambio } }), text: async () => '' };
};

const BLOQUEIO = () => new Error('Failed to get crumb, status 429');
const zerar = () => {
  _zerarDisjuntor();
  yahoo.quotes = []; yahoo.buscas = []; yahoo.historicos = []; yahoo.erro = null;
  yahoo.resposta = { regularMarketPrice: 77, currency: 'BRL' };
  http.urls = []; http.status = 200;
  http.brapi = { results: [{ symbol: 'PETR4', data: { regularMarketPrice: 54.33, currency: 'BRL' } }] };
};

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const ok = (c, m) => { if (!c) falhas.push(m); };

(async () => {

console.log('-- 1. o primeiro 429 fecha a porta --');
{
  zerar();
  ok(!yahooRecusando(), '1 comeca aberto');
  yahoo.erro = BLOQUEIO();
  await buscarCotacaoAcao('AAPL');
  ok(yahooRecusando(), '1 fechou depois do 429');
  eq(yahoo.quotes.length, 1, '1 uma tentativa so');
}
console.log('  ok');

console.log('-- 2. erro de rede COMUM nao fecha a porta --');
{
  // ⚠️ A regressao grave: fechar por soluco de rede tiraria o Yahoo do ar por
  // 10 min sem motivo, e ele e a UNICA fonte de ativo internacional.
  zerar();
  yahoo.erro = new Error('socket hang up');
  await buscarCotacaoAcao('AAPL');
  ok(!yahooRecusando(), '2 soluco de rede NAO fecha');
  eq(yahoo.quotes.length, 3, '2 e o retry continua valendo');
}
console.log('  ok');

console.log('-- 3. a porta e COMPARTILHADA pelos quatro usos --');
{
  zerar();
  marcarYahooBloqueado('teste');

  // dividendo: era o maior desperdicio (44 chamadas recusadas por clique)
  // ⚠️ `null`, NAO 0. Zero significaria "este papel nao paga provento" — e
  // quem chama GRAVA, entao o provedor fora do ar apagaria o historico de
  // proventos do cliente. Esta assercao cravava 0 antes e precisou ser
  // CORRIGIDA, nao afrouxada: o contrato mudou de proposito.
  eq(await buscarDividendos('PETR4.SA'), null, '3 dividendo devolve null (nao sei), nao 0 (nao pagou)');
  eq(yahoo.historicos.length, 0, '3 dividendo NAO chamou o Yahoo');

  // busca
  eq((await buscarTickers('apple')).length, 0, '3 busca devolve vazio');
  eq(yahoo.buscas.length, 0, '3 busca NAO chamou o Yahoo');

  // cotacao de ativo de fora da B3
  eq(await buscarCotacaoAcao('AAPL'), null, '3 cotacao devolve null');
  eq(yahoo.quotes.length, 0, '3 cotacao NAO chamou o Yahoo');

  // cambio: pula o Yahoo e cai na AwesomeAPI
  const c = await taxaParaBRLDetalhe('USD');
  eq(c.taxa, 5.4, '3 cambio ainda funciona');
  eq(c.fonte, 'awesomeapi', '3 cambio veio da 2a fonte');
  eq(yahoo.quotes.length, 0, '3 cambio NAO gastou chamada no Yahoo');
}
console.log('  ok');

console.log('-- 4. porta fechada NAO vira "este ativo nao tem cotacao" --');
{
  // ⚠️ Com motivo errado a tela diz "preencha a mao" para um papel que TEM
  // cotacao — mentiria sobre o ativo e o cliente nunca mais tentaria.
  zerar();
  marcarYahooBloqueado('teste');
  const c = await buscarCotacaoAcao('AAPL');
  eq(c, null, '4 sem preco');
  eq(buscarCotacaoAcao.ultimoErro, 'bloqueio_ip', '4 motivo = bloqueio_ip, nao sem_cotacao');
}
console.log('  ok');

console.log('-- 5. a B3 passa pela porta fechada (a brapi nao e afetada) --');
{
  // ⚠️ O ERRO QUE DESTRUIRIA TUDO: o disjuntor e do YAHOO. Se ele barrasse a
  // brapi, um 429 do Yahoo (que acontece sempre) deixaria a aba inteira sem
  // preco por 10 min — o oposto do que ele existe pra fazer.
  zerar();
  marcarYahooBloqueado('teste');
  const c = await buscarCotacaoAcao('PETR4.SA');
  eq(c?.precoAtual, 54.33, '5 B3 continua cotando com a porta fechada');
  eq(yahoo.quotes.length, 0, '5 e sem tocar no Yahoo');
}
console.log('  ok');

console.log('-- 6. SE CURA sozinho quando a janela passa --');
{
  // ⚠️ Janela e nao interruptor: bloqueio de IP de nuvem muda, e tudo tem de
  // religar sem deploy. Viajo no tempo mexendo no Date.now.
  zerar();
  marcarYahooBloqueado('teste');
  ok(yahooRecusando(), '6 fechado agora');

  const real = Date.now;
  try {
    Date.now = () => real() + JANELA_BLOQUEIO_MS + 1000;
    ok(!yahooRecusando(), '6 reabriu depois da janela');
    const c = await buscarCotacaoAcao('AAPL');
    eq(c?.precoAtual, 77, '6 e o Yahoo volta a responder');
    eq(yahoo.quotes.length, 1, '6 tentou de verdade');
  } finally { Date.now = real; }

  // ⚠️ Um minuto ANTES do fim a porta tem de continuar fechada, senao a janela
  // nao esta sendo respeitada — so "existe".
  marcarYahooBloqueado('teste');
  const real2 = Date.now;
  try {
    Date.now = () => real2() + JANELA_BLOQUEIO_MS - 60000;
    ok(yahooRecusando(), '6 ainda fechado 1min antes do fim');
  } finally { Date.now = real2; }
}
console.log('  ok');

console.log('-- 7. reabriu e levou 429 de novo -> fecha outra vez --');
{
  zerar();
  yahoo.erro = BLOQUEIO();
  await buscarCotacaoAcao('AAPL');
  const real = Date.now;
  try {
    Date.now = () => real() + JANELA_BLOQUEIO_MS + 1000;
    ok(!yahooRecusando(), '7 reabriu');
    await buscarCotacaoAcao('AAPL');   // leva 429 de novo
    ok(yahooRecusando(), '7 fechou de novo');
  } finally { Date.now = real; }
}
console.log('  ok');

console.log('-- 8. o 429 do DIVIDENDO tambem fecha a porta --');
{
  // Quem descobre o bloqueio pode ser qualquer um dos quatro; o primeiro a
  // descobrir tem de avisar os outros tres.
  zerar();
  yahoo.erro = BLOQUEIO();
  await buscarDividendos('PETR4.SA');
  ok(yahooRecusando(), '8 dividendo marcou o bloqueio');
}
console.log('  ok');

console.log('-- 9. o 429 da BUSCA tambem fecha a porta --');
{
  zerar();
  yahoo.erro = BLOQUEIO();
  await buscarTickers('alguma coisa internacional');
  ok(yahooRecusando(), '9 busca marcou o bloqueio');
}
console.log('  ok');

console.log('-- 10. dividendo normal segue funcionando com a porta aberta --');
{
  // A regressao obvia na outra direcao: matar o dividendo de vez.
  zerar();
  eq(await buscarDividendos('PETR4.SA'), 1.5, '10 dividendo le o historico');
  eq(yahoo.historicos.length, 1, '10 chamou o Yahoo');
}
console.log('  ok');

console.log('-- 11. o 429 do CAMBIO tambem fecha a porta --');
{
  // ⚠️ O cambio e o uso mais FACIL de esquecer: ele tem 2 fontes de reserva,
  // entao a taxa volta certa e NADA parece errado — mas sem marcar o bloqueio
  // ele gastaria uma recusa em CADA conversao, e quem descobriu primeiro nao
  // avisaria os outros tres usos. Era a unica mutacao que sobrevivia.
  zerar();
  yahoo.erro = BLOQUEIO();
  const c = await taxaParaBRLDetalhe('USD');
  eq(c.taxa, 5.4, '11 a taxa volta certa pela fonte de reserva');
  eq(c.fonte, 'awesomeapi', '11 veio da 2a fonte');
  ok(yahooRecusando(), '11 e o cambio FECHOU a porta pros outros tres');
}
console.log('  ok');
console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  .', f));
  process.exit(1);
}
console.log('OK disjuntorYahoo: fecha no 429, compartilha, se cura, e nao encosta na brapi');
process.exit(0);
})();
