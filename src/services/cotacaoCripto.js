// =============================================================================
// COTAÇÃO DE CRIPTO PELO MERCADO BITCOIN — porque a CoinGecko recusa o Render.
//
// ⚠️ MEDIDO DE DENTRO DO RENDER (07/10/2026), sondando cinco fontes gratuitas
// de uma vez, que é o único jeito de escolher sem adivinhar:
//
//     CoinGecko ........  429  "You've exceeded the Rate Limit"
//     brapi (cripto) ...  403  "requer o plano Startup (R$ 119,99/mês)"
//     Binance ..........  451  "restricted location"  (a região do Render)
//     CoinCap ..........  fetch failed (a API saiu do ar)
//     Mercado Bitcoin ..  200  BTC R$ 419.000 · ETH R$ 12.935 · PEPE R$ 0,0000205
//
// ⚠️ NÃO SE ESCOLHE FONTE PELA REPUTAÇÃO. A CoinGecko é a melhor API de cripto
// que existe e nos recusa; a Binance é a maior corretora do mundo e bloqueia a
// região. O que decide é quem responde 200 DESTE IP — e a resposta foi a
// corretora brasileira, que de quebra cota em REAL nativo, sem passar por
// câmbio.
//
// ⚠️ O QUE ESTAVA ACONTECENDO ANTES: as 8 posições de cripto da base nunca
// atualizavam, e três delas exibiam número absurdo de uma atualização parcial
// antiga — Ethereum a R$ 0,45 com R$ 452,20 aportados, Bitcoin a R$ 2,31 com
// R$ 4.200. O `catch` da CoinGecko devolvia null, a rota fazia `continue`, e a
// tela seguia mostrando o valor velho sem dizer nada.
// =============================================================================

const BASE = 'https://www.mercadobitcoin.net/api';

/**
 * Os ids da CoinGecko que a base usa, traduzidos pro símbolo da corretora.
 *
 * ⚠️ O TICKER DE CRIPTO NA BASE É O id DA COINGECKO (`bitcoin`, `ethereum`,
 * `pepe`) — foi dela que a busca sempre veio. O Mercado Bitcoin usa o SÍMBOLO
 * (`BTC`, `ETH`, `PEPE`), então sem a tradução toda chamada daria 404.
 *
 * ⚠️ MAPA CURTO DE PROPÓSITO, e isso NÃO limita a cobertura: o que não está
 * aqui cai no palpite "o ticker já é o símbolo", que resolve `BTC` (a base tem
 * uma posição gravada assim) e qualquer moeda nova cujo ticker seja a sigla.
 * Lista longa de moedas envelhece mal — é a lição da lista de ETFs que o
 * projeto decidiu não manter.
 */
const SIMBOLO = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  tether: 'USDT',
  solana: 'SOL',
  ripple: 'XRP',
  cardano: 'ADA',
  dogecoin: 'DOGE',
  litecoin: 'LTC',
  'binancecoin': 'BNB',
  'usd-coin': 'USDC',
  'avalanche-2': 'AVAX',
  polkadot: 'DOT',
  chainlink: 'LINK',
  uniswap: 'UNI',
  stellar: 'XLM',
  pepe: 'PEPE',
  shiba_inu: 'SHIB',
  'shiba-inu': 'SHIB',
  'matic-network': 'MATIC',
  'bitcoin-cash': 'BCH',
};

/** O símbolo que a corretora espera, a partir do que está gravado na base. */
function simboloCripto(ticker) {
  const cru = String(ticker || '').trim();
  if (!cru) return '';
  const mapeado = SIMBOLO[cru.toLowerCase()];
  if (mapeado) return mapeado;
  // Palpite: já é a sigla. Só aceita o que TEM CARA de sigla — 2 a 10 letras ou
  // dígitos, sem espaço. "Bitcoin - NuBanck" (que existe no campo `nome`) não
  // pode virar uma chamada de API.
  return /^[A-Za-z0-9]{2,10}$/.test(cru) ? cru.toUpperCase() : '';
}

/**
 * Lê o preço do corpo do ticker da corretora.
 *
 * ⚠️ `last` VEM COMO STRING com 8 casas ("418969.00000000"). E a variação do
 * dia é calculada do `open` — a corretora não manda o percentual pronto, e
 * inventar 0 esconderia a queda/alta do dia na tela.
 */
function precoDoTicker(corpo) {
  const t = corpo?.ticker;
  const last = Number(t?.last);
  if (!Number.isFinite(last) || last <= 0) return null;

  const open = Number(t?.open);
  const variacaoDia = Number.isFinite(open) && open > 0
    ? ((last - open) / open) * 100
    : 0;

  return { precoAtual: last, variacaoDia, moeda: 'BRL' };
}

/**
 * Cotação de uma cripto, em real.
 *
 * @returns {Promise<Object|null>} `null` quando não veio. O motivo fica em
 *   `cotacaoCriptoMB.ultimoErro` — 'nao_listada' quando a corretora não tem a
 *   moeda (404), que é resposta e não falha.
 */
async function cotacaoCriptoMB(ticker) {
  const s = simboloCripto(ticker);
  if (!s) { cotacaoCriptoMB.ultimoErro = 'ticker_invalido'; return null; }

  let resp;
  try {
    resp = await fetch(`${BASE}/${encodeURIComponent(s)}/ticker/`);
  } catch (e) {
    cotacaoCriptoMB.ultimoErro = `rede: ${e?.message || e}`;
    return null;
  }

  // ⚠️ 404 É RESPOSTA, não falha: a corretora diz COIN_NOT_FOUND pra moeda que
  // ela não lista. Tratar como erro de rede faria o chamador tentar de novo pra
  // sempre por uma moeda que nunca vai existir lá.
  if (resp.status === 404) { cotacaoCriptoMB.ultimoErro = 'nao_listada'; return null; }
  if (!resp.ok) { cotacaoCriptoMB.ultimoErro = `HTTP ${resp.status}`; return null; }

  let corpo = null;
  try { corpo = await resp.json(); } catch { corpo = null; }

  const c = precoDoTicker(corpo);
  cotacaoCriptoMB.ultimoErro = c ? null : 'sem_preco';
  return c;
}

module.exports = { cotacaoCriptoMB, simboloCripto, precoDoTicker };
