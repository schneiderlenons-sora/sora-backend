// =============================================================================
// EVAL — cotação pela brapi (a substituta do Yahoo, que bloqueia o Render).
//
// ⚠️ ESTE EVAL NÃO CHAMA A REDE. Ele trava a TRADUÇÃO: qual símbolo mandar,
// quais tickers são da B3, e como ler a resposta. Foi aí que o Yahoo nos pegou
// — o erro não estava no cálculo, estava no caminho — e é o que dá pra
// garantir sem depender de um serviço de fora estar no ar.
//
// Rodar: node evals/cotacaoBrapi.eval.js
// =============================================================================
const { ehTickerBR, simboloBrapi, precoDoItem } = require('../src/services/cotacaoBrapi');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

console.log('-- 1. o simbolo que a brapi espera --');
{
  // ⚠️ Nossos tickers sao gravados no padrao do YAHOO (PETR4.SA). Mandar o
  // sufixo pra brapi devolve lista vazia, em silencio.
  eq(simboloBrapi('PETR4.SA'), 'PETR4', '§1 tira o .SA');
  eq(simboloBrapi('petr4.sa'), 'PETR4', '§1 e normaliza a caixa');
  eq(simboloBrapi('PETR4'), 'PETR4', '§1 sem sufixo passa igual');
  eq(simboloBrapi('  VALE3.SA  '), 'VALE3', '§1 apara espacos');
  eq(simboloBrapi('BOVA11.SA'), 'BOVA11', '§1 ETF');
  eq(simboloBrapi(''), '', '§1 vazio');
  eq(simboloBrapi(null), '', '§1 null');
  // ⚠️ So no FIM: "SABESP" nao pode virar "SABE".
  eq(simboloBrapi('SAPR4'), 'SAPR4', '§1 nao corta .SA do meio do nome');
}
console.log('  ok');

console.log('-- 2. quem e da B3 (a brapi nao cobre o resto) --');
{
  for (const t of ['PETR4', 'VALE3', 'PETR4.SA', 'BOVA11', 'MXRF11', 'ITUB4', 'bova11.sa']) {
    eq(ehTickerBR(t), true, `§2 ${t} e da B3`);
  }
  // ⚠️ Internacional tem de ser FALSO: mandar AAPL pra brapi volta vazio, e o
  // chamador concluiria "nao tem cotacao" em vez de tentar o outro provedor.
  for (const t of ['AAPL', 'TSLA', 'MSFT', 'BTC', 'GOOGL', '', null, undefined]) {
    eq(ehTickerBR(t), false, `§2 ${t} NAO e da B3`);
  }
}
console.log('  ok');

console.log('-- 3. ler o preco: v2 (aninhado) e v1 (na raiz) --');
{
  // Resposta real da v2, medida em 07/10/2026.
  const v2 = { symbol: 'PETR4', data: { regularMarketPrice: 54.33, currency: 'BRL', regularMarketChangePercent: 0.95, longName: 'Petroleo Brasileiro SA Pfd' } };
  const a = precoDoItem(v2);
  eq(a.precoAtual, 54.33, '§3 v2: preco');
  eq(a.moeda, 'BRL', '§3 v2: moeda');
  eq(a.variacaoDia, 0.95, '§3 v2: variacao');
  eq(a.nomeCompleto, 'Petroleo Brasileiro SA Pfd', '§3 v2: nome');

  // ⚠️ A v1 devolve na RAIZ. Ler so um dos formatos quebraria em silencio se a
  // brapi mudasse a versao do endpoint.
  const v1 = { symbol: 'VALE3', regularMarketPrice: 68.75, currency: 'BRL' };
  eq(precoDoItem(v1).precoAtual, 68.75, '§3 v1: preco na raiz');
}
console.log('  ok');

console.log('-- 4. resposta sem preco NAO vira zero --');
{
  // Zero seria "o ativo nao vale nada" — e isso iria pro patrimonio da pessoa.
  for (const lixo of [
    { data: {} },
    { data: { regularMarketPrice: null } },
    { data: { regularMarketPrice: 0 } },
    { data: { regularMarketPrice: -1 } },
    { data: { regularMarketPrice: 'abc' } },
    {}, null, undefined,
  ]) {
    eq(precoDoItem(lixo), null, `§4 ${JSON.stringify(lixo)} -> null`);
  }
}
console.log('  ok');

console.log('-- 5. preco em texto (a API as vezes manda assim) --');
{
  eq(precoDoItem({ data: { regularMarketPrice: '54.33' } }).precoAtual, 54.33, '§5 string numerica');
  eq(precoDoItem({ data: { regularMarketPrice: 54.33, regularMarketChangePercent: null } }).variacaoDia, 0, '§5 variacao null -> 0');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('OK cotacaoBrapi: traduz o simbolo, separa B3 do resto, e nunca inventa preco');
process.exit(0);
