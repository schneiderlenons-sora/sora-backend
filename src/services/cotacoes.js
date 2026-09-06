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

// ── Câmbio: TRÊS FONTES, porque uma só decide se o cliente vê o dinheiro ──
//
// Relato de 06/09/2026: cliente com contas em NOK marcou a moeda certa e o
// painel passou a dizer "câmbio indisponível agora" nos dois saldos. Medido
// aqui, o par NOKBRL=X do Yahoo responde 0,55032 — ou seja, a cotação existe;
// o que falhou foi a CHAMADA a partir do servidor.
//
// ⚠️ Yahoo bloqueia/limita IP de datacenter, e o Render é exatamente isso.
// Com uma fonte só, uma recusa dela apaga o saldo do usuário — e o efeito é
// pior num plano free que HIBERNA: o cache é um Map em memória, some a cada
// cold start, e aí toda visita depende de uma chamada nova dar certo.
//
// As três concordaram na medição (0,55032 · 0,55057 · 0,5491), então a ordem
// é por confiabilidade, não por preferência de valor. A primeira que
// responder um número plausível vence.
//
// ⚠️ TIMEOUT CURTO E OBRIGATÓRIO. Sem ele, uma fonte pendurada trava a página
// de contas inteira — trocaria "número faltando" por "tela que não carrega".
const CAMBIO_TIMEOUT_MS = 4000;

// Uma cotação plausível: número finito e positivo. Serve de guarda contra
// resposta 200 com corpo de erro, que as APIs gratuitas fazem.
const taxaValida = (v) => Number.isFinite(v) && v > 0;

async function buscarJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CAMBIO_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(t); }
}

const FONTES_CAMBIO = [
  // 1. Yahoo — a de sempre. Continua primeiro: é a mesma que cota as ações,
  //    então quando ela responde tudo no app fala pela mesma régua.
  { nome: 'yahoo', async ler(m) {
    const q = await yahooFinance.quote(`${m}BRL=X`, {}, SEM_VALIDACAO);
    return q?.regularMarketPrice;
  } },
  // 2. AwesomeAPI — brasileira, sem chave, cota par a par contra o real.
  { nome: 'awesomeapi', async ler(m) {
    const j = await buscarJson(`https://economia.awesomeapi.com.br/last/${m}-BRL`);
    const k = j && Object.keys(j)[0];
    return k ? Number(j[k].bid) : null;
  } },
  // 3. open.er-api.com — sem chave, cobertura ampla; a rede de segurança.
  { nome: 'er-api', async ler(m) {
    const j = await buscarJson(`https://open.er-api.com/v6/latest/${m}`);
    return j && j.result === 'success' ? Number(j.rates?.BRL) : null;
  } },
];

/**
 * Taxa de conversão de uma moeda estrangeira → BRL (1 se já for BRL).
 * `null` quando NENHUMA fonte respondeu — nunca 0, nunca 1.
 *
 * ⚠️ Devolver 1 no fracasso seria o pior resultado possível: somaria coroa
 * como se fosse real, calado. É o defeito que o painel já teve.
 */
async function taxaParaBRLDetalhe(moeda) {
  if (!moeda || moeda === 'BRL') return { taxa: 1, fonte: 'padrao' };
  for (const f of FONTES_CAMBIO) {
    try {
      const v = Number(await f.ler(moeda));
      if (taxaValida(v)) return { taxa: v, fonte: f.nome };
    } catch { /* próxima fonte */ }
  }
  // Log com a moeda: sem ele o diagnóstico começa do zero na próxima vez.
  console.warn('[cambio] nenhuma fonte cotou %s→BRL', moeda);
  return { taxa: null, fonte: null };
}

// Só o número — assinatura antiga, usada por routes/investimentos.js.
async function taxaParaBRL(moeda) {
  return (await taxaParaBRLDetalhe(moeda)).taxa;
}

module.exports = {
  buscarCotacaoAcao,
  buscarDividendos,
  buscarTickers,
  buscarCotacaoCripto,
  buscarCriptos,
  listarCriptos,
  taxaParaBRL, taxaParaBRLDetalhe,
};
