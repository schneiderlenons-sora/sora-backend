const YahooFinance = require('yahoo-finance2').default;
const axios = require('axios');

// v3+ exige instância
const yahooFinance = new YahooFinance();

// Suprime warning noise
try { yahooFinance.suppressNotices(['yahooSurvey']); } catch {}

// ─── Yahoo Finance (ações, FIIs, ETFs) ──────────────────────────────
// validateResult:false → o Yahoo às vezes muda campos (ex.: typeDisp "equity"→
// "Equity") e a lib rejeita a resposta inteira por schema. Sem validar, usamos
// os dados que vieram (que estão certos).
const SEM_VALIDACAO = { validateResult: false };

async function buscarCotacaoAcao(ticker) {
  try {
    const quote = await yahooFinance.quote(ticker, {}, SEM_VALIDACAO);
    if (!quote) return null;
    return {
      precoAtual:   quote.regularMarketPrice ?? null,
      variacaoDia:  quote.regularMarketChangePercent ?? 0,
      moeda:        quote.currency || 'BRL',
      nomeCompleto: quote.longName || quote.shortName || ticker,
      setor:        quote.sector || null,
    };
  } catch (err) {
    console.warn(`[cotacoes] yahoo ${ticker}:`, err.message);
    return null;
  }
}

async function buscarDividendos(ticker, dataInicio) {
  try {
    const d = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const historico = await yahooFinance.historical(ticker, { period1: d, events: 'dividends' }, SEM_VALIDACAO);
    return (historico || []).reduce((acc, h) => acc + (h.dividends || 0), 0);
  } catch {
    return 0;
  }
}

async function buscarTickers(query) {
  try {
    const results = await yahooFinance.search(query, { quotesCount: 10, newsCount: 0 }, SEM_VALIDACAO);
    return (results.quotes || []).slice(0, 10).map(r => ({
      ticker:   r.symbol,
      nome:     r.longname || r.shortname || r.symbol,
      tipo:     r.quoteType,
      exchange: r.exchange,
    }));
  } catch (err) {
    console.warn('[cotacoes] yahoo search:', err.message);
    return [];
  }
}

// ─── CoinGecko (cripto) ─────────────────────────────────────────────
async function buscarCotacaoCripto(coinId) {
  try {
    const resp = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=brl&include_24hr_change=true`,
      { timeout: 7000 }
    );
    const data = resp.data?.[coinId];
    if (!data) return null;
    return {
      precoAtual:  data.brl ?? null,
      variacaoDia: data.brl_24h_change ?? 0,
      moeda:       'BRL',
    };
  } catch (err) {
    console.warn(`[cotacoes] coingecko ${coinId}:`, err.message);
    return null;
  }
}

// Cache 24h da lista de criptos
let CRIPTO_LIST_CACHE = null;
let CRIPTO_LIST_CACHE_AT = 0;
async function listarCriptos() {
  if (CRIPTO_LIST_CACHE && Date.now() - CRIPTO_LIST_CACHE_AT < 86400000) {
    return CRIPTO_LIST_CACHE;
  }
  try {
    const resp = await axios.get('https://api.coingecko.com/api/v3/coins/list', { timeout: 10000 });
    // Lista completa (cacheada 24h) — antes cortava em 800 e moedas populares
    // como Bitcoin ficavam de fora da busca.
    CRIPTO_LIST_CACHE = resp.data || [];
    CRIPTO_LIST_CACHE_AT = Date.now();
    return CRIPTO_LIST_CACHE;
  } catch (err) {
    console.warn('[cotacoes] coingecko list:', err.message);
    return [];
  }
}

module.exports = {
  buscarCotacaoAcao,
  buscarDividendos,
  buscarTickers,
  buscarCotacaoCripto,
  listarCriptos,
};
