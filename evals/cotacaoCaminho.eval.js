// =============================================================================
// EVAL — O CAMINHO da cotação, não a aritmética dela.
//
// ⚠️ ESTE EVAL EXISTE PORQUE O ANTERIOR NÃO BASTOU. A função de cotação passava
// em teste isolado e estava MORTA em produção: o Yahoo recusa o IP do Render
// com 429 em 20ms, e nada no código escolhia outro provedor. Testar a função
// sem testar quem ela chama é exatamente o furo que deixou o cliente sem
// cotação por semanas.
//
// Aqui o provedor é FALSO (fetch e yahoo-finance2 interceptados), então o eval
// é determinístico, de graça, e trava o que importa:
//   · papel da B3 vai pra brapi e NÃO toca no Yahoo;
//   · papel de fora NÃO vai pra brapi (ela não cobre);
//   · brapi fora do ar cai pro Yahoo;
//   · 429 do Yahoo é UMA tentativa, não três.
//
// Rodar: node evals/cotacaoCaminho.eval.js
// =============================================================================
const Module = require('module');

// ── Yahoo falso, instalado ANTES de carregar o serviço ──────────────────────
const yahoo = { chamadas: [], buscas: [], resposta: null, erro: null };
const carregarOriginal = Module._load;
Module._load = function (pedido) {
  if (pedido === 'yahoo-finance2') {
    class Falso {
      suppressNotices() {}
      async quote(t) {
        yahoo.chamadas.push(t);
        if (yahoo.erro) throw yahoo.erro;
        return yahoo.resposta;
      }
      async search(q) {
        yahoo.buscas.push(q);
        if (yahoo.erro) throw yahoo.erro;
        return { quotes: [{ symbol: 'YAHOO.SA', longname: 'veio do yahoo' }] };
      }
      async historical() { return []; }
    }
    return { default: Falso };
  }
  return carregarOriginal.apply(this, arguments);
};

const { buscarCotacaoAcao, buscarTickers, ehBloqueio, _zerarDisjuntor } = require('../src/services/cotacoes');

// ── brapi falsa ─────────────────────────────────────────────────────────────
const brapi = { urls: [], resposta: null, status: 200, lancar: null };
global.fetch = async (url, opts) => {
  brapi.urls.push(String(url));
  brapi.ultimoHeader = opts?.headers || {};
  if (brapi.lancar) throw brapi.lancar;
  return {
    ok: brapi.status >= 200 && brapi.status < 300,
    status: brapi.status,
    json: async () => brapi.resposta,
    text: async () => JSON.stringify(brapi.resposta),
  };
};

// ⚠️ ZERA O DISJUNTOR TAMBEM. Ele e estado de MODULO: um 429 em qualquer
// caso fecha a porta do Yahoo por 10 min, e os casos SEGUINTES veem 0 chamadas
// em vez das 1 ou 3 que esperam. Foi exatamente o que aconteceu ao ligar o
// disjuntor: 4 falsos negativos de uma vez. Estado compartilhado entre casos e
// armadilha de eval, nao bug do codigo.
const zerar = () => {
  _zerarDisjuntor();
  yahoo.chamadas = []; yahoo.buscas = []; yahoo.erro = null;
  yahoo.resposta = { regularMarketPrice: 99, currency: 'BRL', longName: 'do yahoo' };
  brapi.urls = []; brapi.status = 200; brapi.lancar = null;
  brapi.resposta = { results: [{ symbol: 'PETR4', data: { regularMarketPrice: 54.33, currency: 'BRL', longName: 'Petrobras PN' } }] };
};

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const ok = (c, m) => { if (!c) falhas.push(m); };

(async () => {

console.log('-- 1. papel da B3: vai pra brapi e NAO toca no Yahoo --');
{
  zerar();
  const c = await buscarCotacaoAcao('PETR4.SA');
  eq(c?.precoAtual, 54.33, '1 preco da brapi');
  eq(c?.nomeCompleto, 'Petrobras PN', '1 nome da brapi');
  eq(yahoo.chamadas.length, 0, '1 NAO chamou o Yahoo');
  ok(brapi.urls[0]?.includes('symbols=PETR4'), '1 mandou o simbolo SEM o .SA');
  ok(!brapi.urls[0]?.includes('.SA'), '1 nada de .SA na URL da brapi');
}
console.log('  ok');

console.log('-- 2. papel de FORA da B3: brapi nao e consultada --');
{
  // ⚠️ A brapi cobre a B3. Mandar AAPL pra ela volta vazio, e o chamador
  // concluiria "nao tem cotacao" em vez de tentar o provedor que cobre.
  zerar();
  const c = await buscarCotacaoAcao('AAPL');
  eq(brapi.urls.length, 0, '2 nao gastou chamada na brapi');
  eq(yahoo.chamadas.length, 1, '2 foi direto pro Yahoo');
  eq(c?.precoAtual, 99, '2 preco do Yahoo');
}
console.log('  ok');

console.log('-- 3. brapi fora do ar -> cai pro Yahoo (nao devolve vazio) --');
{
  zerar();
  brapi.lancar = new Error('ECONNRESET');
  const c = await buscarCotacaoAcao('VALE3.SA');
  eq(c?.precoAtual, 99, '3 o Yahoo salvou');
  eq(yahoo.chamadas.length, 1, '3 tentou o Yahoo');
}
console.log('  ok');

console.log('-- 4. MISSING_TOKEN nao vira preco inventado --');
{
  // Sem BRAPI_TOKEN a brapi recusa FII/ETF. Isso NAO pode virar zero no
  // patrimonio de ninguem — e o Yahoo entra como ultima tentativa.
  zerar();
  brapi.status = 401;
  brapi.resposta = { error: true, code: 'MISSING_TOKEN' };
  yahoo.erro = new Error('Failed to get crumb, status 429');
  const c = await buscarCotacaoAcao('MXRF11.SA');
  eq(c, null, '4 sem preco de lugar nenhum -> null, nunca 0');

  // ⚠️ A brapi as vezes recusa com HTTP 200 e o erro NO CORPO. Olhar so o
  // status deixaria a lista de resultados vazia passar como sucesso, e a cotacao sairia
  // null SEM motivo registrado — ou seja, ninguem descobre que falta o token.
  zerar();
  brapi.status = 200;
  brapi.resposta = { error: true, code: 'MISSING_TOKEN', message: 'token obrigatorio' };
  yahoo.erro = new Error('Failed to get crumb, status 429');
  const c200 = await buscarCotacaoAcao('BOVA11.SA');
  eq(c200, null, '4 erro no corpo com status 200 -> null');
  const { cotacaoBrapi } = require('../src/services/cotacaoBrapi');
  eq(cotacaoBrapi.ultimoErro, 'MISSING_TOKEN', '4 o MOTIVO fica registrado, nao some');
}
console.log('  ok');

console.log('-- 5. 429 do Yahoo: UMA tentativa, nao tres --');
{
  // ⚠️ A LINHA MAIS IMPORTANTE DO ARQUIVO. O retry foi feito pra soluco de
  // rede; contra bloqueio de IP ele gasta 1,2s do usuario PARADO na tela e
  // bate tres vezes na porta de quem ja nos recusou.
  zerar();
  yahoo.erro = new Error('Failed to get crumb, status 429');
  const t0 = Date.now();
  const c = await buscarCotacaoAcao('AAPL');
  const ms = Date.now() - t0;
  eq(c, null, '5 devolve null');
  eq(yahoo.chamadas.length, 1, '5 UMA tentativa so');
  eq(buscarCotacaoAcao.ultimoErro, 'bloqueio_ip', '5 motivo distinguivel de falha_rede');
  ok(ms < 250, `5 nao esperou backoff (${ms}ms)`);
}
console.log('  ok');

console.log('-- 6. erro de rede COMUM ainda tenta de novo --');
{
  // A regressao obvia: estreitar demais a guarda e matar o retry que resolveu
  // um relato real (cotacao que falhava por soluco e voltava na 2a chamada).
  zerar();
  yahoo.erro = new Error('socket hang up');
  const c = await buscarCotacaoAcao('AAPL');
  eq(c, null, '6 devolve null');
  eq(yahoo.chamadas.length, 3, '6 as TRES tentativas aconteceram');
  eq(buscarCotacaoAcao.ultimoErro, 'falha_rede', '6 motivo de rede');
}
console.log('  ok');

console.log('-- 7. ehBloqueio: le o status E a mensagem --');
{
  // ⚠️ A lib nao expoe o status: o erro real do Render e "Failed to get crumb,
  // status 429" e err.response chega indefinido. Olhar so o status deixaria
  // passar justamente o caso que motivou tudo isso.
  ok(ehBloqueio(new Error('Failed to get crumb, status 429')), '7 429 na mensagem');
  ok(ehBloqueio(new Error('Request failed with status code 403')), '7 403 na mensagem');
  ok(ehBloqueio(new Error('Too Many Requests')), '7 frase do Yahoo');
  ok(ehBloqueio({ response: { status: 429 } }), '7 status estruturado');
  ok(ehBloqueio({ status: 403 }), '7 status na raiz');
  // E nao pode confundir soluco com bloqueio:
  ok(!ehBloqueio(new Error('socket hang up')), '7 rede NAO e bloqueio');
  ok(!ehBloqueio(new Error('status 500')), '7 500 NAO e bloqueio');
  ok(!ehBloqueio(new Error('timeout of 7000ms exceeded')), '7 timeout NAO e bloqueio');
  ok(!ehBloqueio(new Error('')), '7 erro vazio NAO e bloqueio');
  // ⚠️ Numero SOLTO dentro de outro numero nao conta ("4290" nao e 429).
  ok(!ehBloqueio(new Error('order 4290 failed')), '7 4290 nao e 429');
}
console.log('  ok');

console.log('-- 8. busca de ticker: brapi na frente, Yahoo atras --');
{
  zerar();
  brapi.resposta = { stocks: [
    { stock: 'PETR4', name: 'PETROBRAS PN', type: 'stock' },
    { stock: 'BOVA11', name: 'ISHARES BOVA', type: 'fund' },
  ] };
  const r = await buscarTickers('petr');
  eq(r.length, 2, '8 dois resultados');
  // ⚠️ COM .SA: e o formato que os ~700 investimentos da base ja usam. Devolver
  // "PETR4" puro criaria uma segunda grafia do mesmo papel.
  eq(r[0].ticker, 'PETR4.SA', '8 devolve no formato da base');
  eq(r[0].nome, 'PETROBRAS PN', '8 nome');
  eq(r[1].tipo, 'ETF', '8 fund -> ETF');
  eq(r[0].tipo, 'EQUITY', '8 stock -> EQUITY');
  eq(yahoo.buscas.length, 0, '8 nao precisou do Yahoo');

  // brapi vazia -> Yahoo responde
  zerar();
  brapi.resposta = { stocks: [] };
  const r2 = await buscarTickers('apple');
  eq(r2[0]?.ticker, 'YAHOO.SA', '8 vazio na brapi -> cai pro Yahoo');

  // termo curto nao gasta chamada
  zerar();
  await buscarTickers('a');
  eq(brapi.urls.length, 0, '8 1 letra nao consulta a brapi');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  .', f));
  process.exit(1);
}
console.log('OK cotacaoCaminho: B3 pela brapi, resto pelo Yahoo, e 429 nao vira espera');
process.exit(0);
})();
