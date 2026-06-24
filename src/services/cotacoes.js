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

// Busca cripto pelo endpoint /search do CoinGecko (leve e já ranqueado por
// relevância/market cap) — mais confiável que baixar a lista inteira (~3MB).
async function buscarCriptos(q) {
  try {
    const resp = await axios.get(
      `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`,
      { timeout: 7000 }
    );
    return (resp.data?.coins || []).slice(0, 12).map(c => ({
      id: c.id, symbol: c.symbol, name: c.name, market_cap_rank: c.market_cap_rank,
    }));
  } catch (err) {
    console.warn('[cotacoes] coingecko search:', err.message);
    // fallback: filtra a lista completa (cacheada)
    try {
      const ql = q.toLowerCase();
      return (await listarCriptos())
        .filter(c => c.name?.toLowerCase().includes(ql) || c.symbol?.toLowerCase().includes(ql))
        .slice(0, 12);
    } catch { return []; }
  }
}

// Taxa de conversão de uma moeda estrangeira → BRL (1 se já for BRL).
// Usa o par cambial do Yahoo (ex.: USDBRL=X).
async function taxaParaBRL(moeda) {
  if (!moeda || moeda === 'BRL') return 1;
  try {
    const q = await yahooFinance.quote(`${moeda}BRL=X`, {}, SEM_VALIDACAO);
    return q?.regularMarketPrice || null;
  } catch { return null; }
}

module.exports = {
  buscarCotacaoAcao,
  buscarDividendos,
  buscarTickers,
  buscarCotacaoCripto,
  buscarCriptos,
  listarCriptos,
  taxaParaBRL,
};
