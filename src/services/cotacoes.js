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

// ─── A B3 VAI PELA BRAPI ────────────────────────────────────────────────────
//
// ⚠️ MEDIDO DE DENTRO DO RENDER (07/10/2026), que é o único lugar que conta:
//
//     Yahoo  →  429 "Too Many Requests" em 20ms   (recusa de IP de nuvem)
//     brapi  →  200 · PETR4 R$ 54,33 em 170ms
//
// Os 20ms provam que não é limite de volume nosso — é bloqueio de faixa. O
// recurso estava morto em produção para TODOS os usuários (busca de ativo,
// cadastro, botão "Atualizar cotações" e o cron das 03:00) enquanto passava em
// qualquer teste local. Medir na máquina errada custou uma rodada inteira.
//
// ⚠️ O YAHOO FICA, não some: ele é a única fonte para ativo de FORA da B3
// (AAPL e afins), que a brapi não cobre. Hoje ele responde 429 no Render, então
// internacional segue sem cotação automática — mas quando o bloqueio passar,
// volta sozinho, sem deploy.
const { cotacaoBrapi, buscarTickersBrapi, ehTickerBR } = require('./cotacaoBrapi');
// Cripto: a CoinGecko também recusa o IP do Render (ver FONTES_CRIPTO).
const { cotacaoCriptoMB } = require('./cotacaoCripto');

/** Espera o tempo pedido, em ms. */
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Este erro é recusa de IP (429/403), e não um soluço de rede?
 *
 * ⚠️ Lido da MENSAGEM porque a lib não expõe o status de forma confiável: o
 * erro que o Render devolve é `Failed to get crumb, status 429` — o 429 veio na
 * etapa do crumb, dentro da lib, e `err.response` chega indefinido. Procurar só
 * em `err.response.status` deixaria passar justamente o caso real.
 */
function ehBloqueio(err) {
  const s = Number(err?.response?.status ?? err?.status);
  if (s === 429 || s === 403) return true;
  const msg = String(err?.message || '').toLowerCase();
  // Numero cercado por nao-digito, pra "4290" nao passar por 429.
  if (/(^|[^0-9])(429|403)([^0-9]|$)/.test(msg)) return true;
  return msg.includes('too many requests') || msg.includes('forbidden');
}

// ─── DISJUNTOR DO YAHOO ─────────────────────────────────────────────────────
//
// ⚠️ MEDIDO: com a cotação voltando pela brapi, o botão "Atualizar cotações" do
// maior grupo da base (44 posições) faria ~7,5s de brapi MAIS ~15,4s de
// chamadas de dividendo ao Yahoo, TODAS recusadas — 23s de espera com mais da
// metade jogada no lixo. O Yahoo ainda é chamado em quatro lugares (cotação de
// ativo de fora da B3, dividendos, busca e câmbio), e nenhum deles sabia do
// bloqueio que o outro já tinha descoberto.
//
// Então o primeiro 429 fecha a porta por um tempo e os outros três param de
// bater nela. Não é cache de PREÇO — é memória de RECUSA.
//
// ⚠️ SE CURA SOZINHO, e é por isso que é janela e não interruptor: passados os
// 10 min, a próxima chamada tenta de verdade. Se o Yahoo voltar (bloqueio de IP
// de nuvem muda), tudo religa sem deploy. Uma env var exigiria alguém perceber.
//
// ⚠️ NÃO VALE PRA BRAPI. Ela é a fonte principal da B3; um disjuntor ali
// transformaria um soluço de 10s em 10 min de aba sem preço.
const JANELA_BLOQUEIO_MS = 10 * 60 * 1000;
let yahooBloqueadoAte = 0;

/** O Yahoo nos recusou agora há pouco? */
function yahooRecusando() {
  return Date.now() < yahooBloqueadoAte;
}

/** Fecha a porta do Yahoo pela janela. Chamado por quem levou o 429. */
function marcarYahooBloqueado(onde) {
  const primeira = !yahooRecusando();
  yahooBloqueadoAte = Date.now() + JANELA_BLOQUEIO_MS;
  // ⚠️ Só a PRIMEIRA vez loga: senão 44 posições viram 44 linhas iguais e o log
  // do Render fica inútil justamente quando se precisa dele.
  if (primeira) {
    console.error(`[cotacoes] Yahoo recusou o IP (em ${onde}) — pausando o Yahoo por 10min`);
  }
}

/**
 * Cotação de ação/FII/ETF, com RETRY.
 *
 * ⚠️ O RETRY EXISTE POR UM RELATO REAL (out/2026): um cliente selecionou
 * "PETR4.SA" na busca — ou seja, o ticker FOI encontrado — e mesmo assim a tela
 * respondeu "não achei a cotação automática". Medido depois, na mesma conta e
 * no mesmo ticker: a cotação voltou normalmente (R$ 54,16), e 12 chamadas em
 * paralelo deram 12 acertos. Ou seja, a falha dele foi TRANSITÓRIA — e uma
 * única tentativa transformava um soluço de rede em "este recurso não funciona".
 *
 * ⚠️ DUAS TENTATIVAS EXTRAS, com espera curta. O usuário está PARADO na tela
 * esperando o preço aparecer: um backoff longo seria pior que a falha, porque
 * ele desiste antes. ~1,2s no pior caso.
 *
 * ⚠️ DISTINGUE "não existe" de "falhou". O Yahoo responder SEM preço é uma
 * resposta ("este papel não tem cotação") e não se repete; erro de rede/429 é
 * falha e vale tentar de novo. Tratar os dois igual é o que fazia a tela dizer
 * a mesma frase nos dois casos.
 *
 * @returns {Promise<Object|null>} a cotação, ou null. Em null, a propriedade
 *   ultimoErro guarda o motivo pra quem quiser diferenciar (ver /cotacao).
 */
async function buscarCotacaoAcao(ticker) {
  // Papel da B3 → brapi. É o caminho de 99% da base (os tickers gravados são
  // quase todos .SA), e é o único que responde do Render hoje.
  if (ehTickerBR(ticker)) {
    const c = await cotacaoBrapi(ticker);
    if (c) {
      buscarCotacaoAcao.ultimoErro = null;
      return c;
    }
    // ⚠️ MISSING_TOKEN é problema NOSSO (falta `BRAPI_TOKEN` no Render), não do
    // ativo — sem este log ele viraria "não achei a cotação" na cara do cliente
    // e ninguém descobriria. Medido: sem token, PETR4 e VALE3 respondem, mas
    // BOVA11 (ETF) e MXRF11 (FII) voltam MISSING_TOKEN.
    const motivo = cotacaoBrapi.ultimoErro;
    if (motivo && motivo !== 'sem_resultado') {
      console.error(`[cotacoes] brapi ${ticker}: ${motivo}`);
    }
    // Cai pro Yahoo: se a brapi falhou por rede, ele ainda pode salvar.
  }

  // ⚠️ PORTA FECHADA DEVOLVE 'bloqueio_ip', NUNCA null mudo: é esse motivo que
  // faz a tela dizer "falhou agora, tente de novo" em vez de "este ativo não
  // tem cotação" — que seria mentira sobre o ativo.
  if (yahooRecusando()) {
    buscarCotacaoAcao.ultimoErro = 'bloqueio_ip';
    return null;
  }

  let erro = null;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    try {
      const quote = await yahooFinance.quote(ticker, {}, SEM_VALIDACAO);
      // Resposta sem preço é RESPOSTA, não falha: não adianta repetir.
      if (!quote || quote.regularMarketPrice == null) {
        buscarCotacaoAcao.ultimoErro = quote ? 'sem_preco' : 'sem_resposta';
        return null;
      }
      buscarCotacaoAcao.ultimoErro = null;
      return {
        precoAtual:   quote.regularMarketPrice,
        variacaoDia:  quote.regularMarketChangePercent ?? 0,
        moeda:        quote.currency || 'BRL',
        nomeCompleto: quote.longName || quote.shortName || ticker,
        setor:        quote.sector || null,
      };
    } catch (err) {
      erro = err;
      console.warn(`[cotacoes] yahoo ${ticker} (tentativa ${tentativa + 1}/3):`, err.message);
      // ⚠️ CONTRA 429 NÃO SE INSISTE. O retry foi feito pra soluço de rede, que
      // passa; bloqueio de IP não passa em 300ms — insistir só gasta 1,2s do
      // usuário PARADO na tela esperando o preço, e mais três batidas na porta
      // de quem já nos recusou. Medido no Render: o 429 volta em 20ms, sempre.
      if (ehBloqueio(err)) {
        marcarYahooBloqueado(`cotação de ${ticker}`);
        buscarCotacaoAcao.ultimoErro = 'bloqueio_ip';
        console.error(`[cotacoes] yahoo ${ticker}: IP recusado (429/403) — não insisto`);
        return null;
      }
      if (tentativa < 2) await dormir(300 * (tentativa + 1));
    }
  }
  buscarCotacaoAcao.ultimoErro = 'falha_rede';
  console.error(`[cotacoes] yahoo ${ticker}: desisti depois de 3 tentativas —`, erro?.message);
  return null;
}

async function buscarDividendos(ticker, dataInicio) {
  // ⚠️ ERA DAQUI QUE VINHAM OS 15,4s DESPERDIÇADOS. Dividendo só tem fonte no
  // Yahoo, e o `catch` devolvia 0 — então a espera era invisível, só lenta.
  //
  // ⚠️ E DEVOLVER 0 ERA PIOR QUE LENTO: `null` é "não consegui ler", 0 é "este
  // papel não pagou dividendo". Quem chama GRAVA o resultado, então os dois
  // colapsados em 0 fazem o provedor fora do ar APAGAR o histórico de proventos
  // do cliente. Mesma regra do `patchDoSaldo`: calar não é apagar.
  if (yahooRecusando()) return null;
  try {
    const d = dataInicio ? new Date(dataInicio) : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const historico = await yahooFinance.historical(ticker, { period1: d, events: 'dividends' }, SEM_VALIDACAO);
    return (historico || []).reduce((acc, h) => acc + (h.dividends || 0), 0);
  } catch (err) {
    if (ehBloqueio(err)) marcarYahooBloqueado('dividendos');
    // Falha de leitura também é "não sei", nunca "não pagou".
    return null;
    return 0;
  }
}

async function buscarTickers(query) {
  // ⚠️ A BUSCA MORRE PELO MESMO 429 — é recusa de IP, não de endpoint. Sem a
  // brapi aqui o cliente não consegue nem ACHAR o papel pra cadastrar, e o
  // campo de digitar o ticker à mão (que adicionamos) é remendo de sintoma.
  const b = await buscarTickersBrapi(query);
  if (b.length) return b;

  if (yahooRecusando()) return [];

  try {
    const results = await yahooFinance.search(query, { quotesCount: 10, newsCount: 0 }, SEM_VALIDACAO);
    return (results.quotes || []).slice(0, 10).map(r => ({
      ticker:   r.symbol,
      nome:     r.longname || r.shortname || r.symbol,
      tipo:     r.quoteType,
      exchange: r.exchange,
    }));
  } catch (err) {
    if (ehBloqueio(err)) marcarYahooBloqueado('busca');
    else console.warn('[cotacoes] yahoo search:', err.message);
    return [];
  }
}

// ─── CoinGecko (cripto) ─────────────────────────────────────────────
/**
 * As fontes de cripto, em ordem. Mesmo desenho do `FONTES_CAMBIO`, que é o que
 * mantém o câmbio de pé enquanto o Yahoo nos recusa.
 *
 * ⚠️ MEDIDO DE DENTRO DO RENDER (07/10/2026), sondando cinco de uma vez:
 * CoinGecko 429 · brapi 403 (exige plano de R$ 119,99/mês) · Binance 451
 * (região restrita) · CoinCap fora do ar · **Mercado Bitcoin 200**.
 *
 * ⚠️ A COINGECKO FICA PRIMEIRO, mesmo recusando o Render: ela cobre MUITO mais
 * moeda, e volta sozinha se o bloqueio passar. Tirá-la deixaria a cobertura
 * presa no que a corretora brasileira lista.
 */
const FONTES_CRIPTO = [
  { nome: 'coingecko', async ler(coinId) {
    const resp = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=brl&include_24hr_change=true`,
      { timeout: 7000 }
    );
    const data = resp.data?.[coinId];
    if (!data || data.brl == null) return null;
    return { precoAtual: data.brl, variacaoDia: data.brl_24h_change ?? 0, moeda: 'BRL' };
  } },
  // Corretora brasileira: cota em REAL nativo, sem passar por câmbio.
  { nome: 'mercadobitcoin', ler: (coinId) => cotacaoCriptoMB(coinId) },
];

/**
 * Cotação de cripto, em real.
 *
 * ⚠️ AS 8 POSIÇÕES DE CRIPTO DA BASE NUNCA ATUALIZAVAM, e três exibiam número
 * absurdo de uma atualização parcial antiga: Ethereum a R$ 0,45 com R$ 452,20
 * aportados, Bitcoin a R$ 2,31 com R$ 4.200. A CoinGecko devolvia null, a rota
 * fazia `continue`, e a tela seguia com o valor velho sem dizer nada.
 */
async function buscarCotacaoCripto(coinId) {
  for (const f of FONTES_CRIPTO) {
    try {
      const c = await f.ler(coinId);
      // ⚠️ PREÇO TEM DE SER NÚMERO POSITIVO pra valer. Zero ou null seguem pra
      // próxima fonte: "esta moeda não vale nada" iria direto pro patrimônio.
      if (c && Number.isFinite(Number(c.precoAtual)) && Number(c.precoAtual) > 0) {
        buscarCotacaoCripto.ultimaFonte = f.nome;
        return { ...c, precoAtual: Number(c.precoAtual) };
      }
    } catch { /* próxima fonte */ }
  }
  // Log com a moeda: sem ele o diagnóstico começa do zero na próxima vez.
  console.warn('[cotacoes] nenhuma fonte cotou a cripto %s', coinId);
  buscarCotacaoCripto.ultimaFonte = null;
  return null;
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
    // ⚠️ O CÂMBIO NÃO QUEBRA sem o Yahoo — as duas fontes abaixo cobrem. Mas
    // tentá-lo primeiro gastava uma recusa em CADA conversão. Pular vai direto
    // na AwesomeAPI.
    if (yahooRecusando()) return null;
    try {
      const q = await yahooFinance.quote(`${m}BRL=X`, {}, SEM_VALIDACAO);
      return q?.regularMarketPrice;
    } catch (err) {
      if (ehBloqueio(err)) marcarYahooBloqueado('câmbio');
      throw err; // o laço de fontes cuida: vai pra próxima.
    }
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
  ehBloqueio, // exportado pro eval: e a linha que decide se insistimos ou nao
  // O disjuntor é estado de MÓDULO; sem porta pra ele o eval não consegue
  // provar que a porta fecha, que se cura, e que não contamina a brapi.
  yahooRecusando, marcarYahooBloqueado, JANELA_BLOQUEIO_MS,
  _zerarDisjuntor: () => { yahooBloqueadoAte = 0; },
  buscarDividendos,
  buscarTickers,
  buscarCotacaoCripto, FONTES_CRIPTO,
  buscarCriptos,
  listarCriptos,
  taxaParaBRL, taxaParaBRLDetalhe,
};
