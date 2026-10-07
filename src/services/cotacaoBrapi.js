// =============================================================================
// COTAÇÃO PELA BRAPI — porque o Yahoo bloqueia o IP do Render.
//
// ⚠️ MEDIDO DE DENTRO DO RENDER (07/10/2026), que é o único lugar que importa:
//
//     Yahoo  →  429 "Too Many Requests" em 20ms   (bloqueio de faixa de nuvem)
//     brapi  →  200 · PETR4 R$ 54,33 em 170ms
//
// O 429 em 20ms não é limite de volume nosso: é recusa de IP. Por isso o
// recurso estava morto em produção para TODOS os usuários — cadastro de ação,
// botão "Atualizar cotações" e o cron das 03:00 — enquanto funcionava em
// qualquer teste local. Foi exatamente a armadilha de medir no lugar errado.
//
// ⚠️ O TOKEN NÃO É OPCIONAL NA PRÁTICA. Sem ele a brapi atende só parte do
// catálogo: medido, PETR4 e VALE3 respondem, mas BOVA11 (ETF) e MXRF11 (FII)
// devolvem MISSING_TOKEN — e FII/ETF são pão-de-cada-dia na carteira de quem
// usa a Sora. Sem `BRAPI_TOKEN` o serviço funciona pela metade, e é melhor que
// zero, mas não é o estado final.
// =============================================================================

const BASE = 'https://brapi.dev/api/v2/stocks/quote';

/**
 * O símbolo como a brapi espera.
 *
 * ⚠️ Nossos tickers são gravados no padrão do Yahoo (`PETR4.SA`), porque a
 * busca de ativo sempre devolveu assim. A brapi usa o código B3 puro
 * (`PETR4`) — mandar o sufixo devolve lista vazia, em silêncio.
 */
function simboloBrapi(ticker) {
  return String(ticker || '').trim().toUpperCase().replace(/\.SA$/, '');
}

/**
 * Este ticker é da B3?
 *
 * ⚠️ A brapi cobre a bolsa brasileira. Mandar AAPL pra ela devolveria vazio, e
 * o chamador concluiria "não tem cotação" — quando o certo é tentar o outro
 * provedor. Padrão B3: 4 letras + 1 ou 2 dígitos (PETR4, BOVA11, MXRF11), com
 * ou sem o sufixo `.SA`.
 */
function ehTickerBR(ticker) {
  const t = simboloBrapi(ticker);
  if (/\.SA$/i.test(String(ticker || ''))) return true;
  return /^[A-Z]{4}\d{1,2}$/.test(t);
}

/**
 * Lê o preço de um item da resposta.
 *
 * ⚠️ A v2 aninha em `data`; a v1 devolve os campos na raiz. Ler só um dos dois
 * quebraria em silêncio se a brapi mudasse a versão do endpoint.
 */
function precoDoItem(item) {
  const d = item?.data || item;
  const p = Number(d?.regularMarketPrice);
  if (!Number.isFinite(p) || p <= 0) return null;
  return {
    precoAtual:   p,
    variacaoDia:  Number(d?.regularMarketChangePercent) || 0,
    moeda:        d?.currency || 'BRL',
    nomeCompleto: d?.longName || d?.shortName || item?.symbol || null,
    setor:        null,
  };
}

/**
 * Cotação de um ou mais ativos da B3.
 *
 * @param {string[]} tickers
 * @returns {Promise<{ porTicker: Map<string,Object>, erro: string|null }>}
 *   `porTicker` é indexado pelo ticker COMO VEIO (com `.SA` se tinha), pra o
 *   chamador não ter de desfazer a conversão.
 */
async function cotacoesBrapi(tickers) {
  const porTicker = new Map();
  const lista = (tickers || []).filter(Boolean);
  if (!lista.length) return { porTicker, erro: null };

  const simbolos = [...new Set(lista.map(simboloBrapi))].filter(Boolean);
  if (!simbolos.length) return { porTicker, erro: null };

  const headers = {};
  if (process.env.BRAPI_TOKEN) headers.Authorization = `Bearer ${process.env.BRAPI_TOKEN}`;

  let resp;
  try {
    resp = await fetch(`${BASE}?symbols=${encodeURIComponent(simbolos.join(','))}`, { headers });
  } catch (e) {
    return { porTicker, erro: `rede: ${e?.message || e}` };
  }

  let corpo = null;
  try { corpo = await resp.json(); } catch { corpo = null; }

  if (!resp.ok || corpo?.error) {
    // ⚠️ O MOTIVO VOLTA PRO CHAMADOR. 'MISSING_TOKEN' (falta configurar) é um
    // problema nosso e precisa aparecer no log; 429 é limite e vale tentar
    // depois. Colapsar os dois em "não achei" foi o que escondeu o bloqueio do
    // Yahoo por semanas.
    const motivo = corpo?.code || corpo?.message || `HTTP ${resp.status}`;
    return { porTicker, erro: String(motivo) };
  }

  const achados = new Map();
  for (const item of corpo?.results || []) {
    const chave = simboloBrapi(item?.symbol || item?.requestedSymbol);
    const c = precoDoItem(item);
    if (chave && c) achados.set(chave, c);
  }
  // Devolve indexado pelo ticker original.
  for (const t of lista) {
    const c = achados.get(simboloBrapi(t));
    if (c) porTicker.set(t, c);
  }
  return { porTicker, erro: null };
}

/** Cotação de UM ativo da B3. `null` quando não veio. */
async function cotacaoBrapi(ticker) {
  const { porTicker, erro } = await cotacoesBrapi([ticker]);
  if (erro) cotacaoBrapi.ultimoErro = erro;
  else cotacaoBrapi.ultimoErro = porTicker.has(ticker) ? null : 'sem_resultado';
  return porTicker.get(ticker) || null;
}

/**
 * BUSCA de ticker na B3.
 *
 * ⚠️ A BUSCA ESTAVA NO MESMO BARCO. Ela também é Yahoo (`yahooFinance.search`),
 * e o 429 que mata a cotação mata a busca pelo mesmo motivo: é recusa de IP, não
 * de endpoint. Sem isto o cliente não consegue nem ACHAR o papel pra cadastrar —
 * o campo de ticker digitado à mão existe justamente porque a lista vinha vazia.
 *
 * ⚠️ DEVOLVE O TICKER COM `.SA`, e isso é de propósito: é o formato que a base
 * inteira já tem gravado (padrão Yahoo, 700 investimentos). Devolver "PETR4" puro
 * criaria uma segunda grafia do mesmo papel, e aí o mesmo ativo teria duas
 * linhas que nunca se reconhecem.
 */
async function buscarTickersBrapi(query) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  const headers = {};
  if (process.env.BRAPI_TOKEN) headers.Authorization = `Bearer ${process.env.BRAPI_TOKEN}`;

  try {
    const r = await fetch(
      `https://brapi.dev/api/quote/list?search=${encodeURIComponent(q)}&limit=10`,
      { headers },
    );
    if (!r.ok) {
      buscarTickersBrapi.ultimoErro = `HTTP ${r.status}`;
      return [];
    }
    const corpo = await r.json();
    if (corpo?.error) {
      buscarTickersBrapi.ultimoErro = String(corpo.code || corpo.message);
      return [];
    }
    buscarTickersBrapi.ultimoErro = null;
    return (corpo?.stocks || []).slice(0, 10).map((s) => ({
      ticker:   `${String(s.stock || '').toUpperCase()}.SA`,
      nome:     s.name || s.stock || '',
      // `type` da brapi: stock | fund | bdr. Traduzido pro vocabulário que a
      // tela já usa (o mesmo `quoteType` do Yahoo), senão o rótulo sai em inglês
      // cru pra metade dos resultados e igual pra outra.
      tipo:     s.type === 'fund' ? 'ETF' : s.type === 'bdr' ? 'BDR' : 'EQUITY',
      exchange: 'SAO',
    })).filter((x) => x.ticker !== '.SA');
  } catch (e) {
    buscarTickersBrapi.ultimoErro = `rede: ${e?.message || e}`;
    return [];
  }
}

module.exports = { cotacaoBrapi, cotacoesBrapi, buscarTickersBrapi, ehTickerBR, simboloBrapi, precoDoItem };
