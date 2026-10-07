const express  = require('express');
// ⚠️ Regra CANÔNICA do que conta como gasto — a mesma do resumo do mês e do
// SSR. Reimplementar aqui faria a reserva divergir do resto do painel.
const { ehTransferencia } = require('../services/resumoTransacoes');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPlano } = require('../middlewares/plano');
const { exigirPermissao } = require('../middlewares/permissao');
const {
  buscarCotacaoAcao, buscarDividendos, buscarTickers,
  buscarCotacaoCripto, buscarCriptos, listarCriptos, taxaParaBRL,
} = require('../services/cotacoes');
// Moeda base do grupo (migration 168): cotação em real vira a moeda do grupo.
const { moedaBaseDoGrupo, taxasParaBase, taxaEntre, fatorCotacaoParaBase } = require('../services/moeda');
const { debitarConta } = require('../services/contaDebito');
const { custoMensalDividas } = require('../services/custoMensalDividas');

const norm = p => p?.replace(/\D/g, '');

async function getGrupoId(req) {
  const { data } = await supabase.from('users')
    .select('grupo_ativo').eq('id', req.authUser?.id || '__none__').single();
  return data?.grupo_ativo || null;
}

// A aritmética do aporte e a trava de Open Finance moram no service — puras e
// cobertas por `npm run eval:aporte`. A rota só orquestra.
const { aplicarAporte, recusaSeDoBanco } = require('../services/aporteInvestimento');
const { planoDeAtualizarValor } = require('../services/valorInvestimento');

// ── BUSCAS PÚBLICAS DE COTAÇÃO ───────────────────────────────────

/**
 * GET /api/investimentos/diag-cotacao?key=<API_SECRET_TOKEN>
 *
 * ⚠️ EXISTE PORQUE "FUNCIONA NA MINHA MÁQUINA" NÃO É MEDIÇÃO. Um cliente
 * relatou que a cotação não vem; aqui, local, o fluxo inteiro responde (busca →
 * escolhe → preço, R$ 54,33). A diferença que sobra é o AMBIENTE: o Yahoo
 * costuma limitar ou bloquear IP de nuvem, e o Render é nuvem.
 *
 * Esta rota roda DE DENTRO do Render e devolve o erro CRU — que é o único jeito
 * de saber se o problema é rede, bloqueio, timeout ou outra coisa. Sem ela, o
 * `catch` engole tudo e a tela diz sempre a mesma frase.
 *
 * Aberta por CHAVE (mesmo padrão do /webhook/meta/diag): o diagnóstico precisa
 * funcionar sem sessão de usuário, que é o que se está tentando descartar.
 */
router.get('/diag-cotacao', async (req, res) => {
  if (req.query.key !== process.env.API_SECRET_TOKEN) return res.sendStatus(403);

  // ── SONDA DE CRIPTO: ?cripto=bitcoin,ethereum ─────────────────────────────
  //
  // Cripto não passa nem pelo Yahoo nem pela brapi — é CoinGecko. Medido na
  // base: 7 posições com dinheiro de verdade e valor visivelmente errado (ETH
  // a R$ 0,45 com R$ 452 aportados). Esta sonda diz se a CoinGecko responde
  // DAQUI, e compara com a cripto da brapi, que já temos token.
  if (req.query.cripto) {
    const moedas = String(req.query.cripto).split(',').map((m) => m.trim()).filter(Boolean);
    const saida = [];
    for (const m of moedas) {
      const linha = { moeda: m };

      const t1 = Date.now();
      try {
        const c = await buscarCotacaoCripto(m.toLowerCase());
        linha.pelaSora = { ms: Date.now() - t1, preco: c?.precoAtual ?? null };
      } catch (e) { linha.pelaSora = { erro: e?.message || String(e) }; }

      const t2 = Date.now();
      try {
        const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(m.toLowerCase())}&vs_currencies=brl`);
        const txt = await r.text();
        linha.coingeckoCru = { status: r.status, ms: Date.now() - t2, trecho: txt.slice(0, 160) };
      } catch (e) { linha.coingeckoCru = { erro: e?.message || String(e) }; }

      const t3 = Date.now();
      try {
        const h = {};
        if (process.env.BRAPI_TOKEN) h.Authorization = `Bearer ${process.env.BRAPI_TOKEN}`;
        const sigla = { bitcoin: 'BTC', ethereum: 'ETH', pepe: 'PEPE', solana: 'SOL' }[m.toLowerCase()] || m.toUpperCase();
        const r = await fetch(`https://brapi.dev/api/v2/crypto/quote?coin=${sigla}&currency=BRL`, { headers: h });
        const txt = await r.text();
        linha.brapiCripto = { sigla, status: r.status, ms: Date.now() - t3, trecho: txt.slice(0, 200) };
      } catch (e) { linha.brapiCripto = { erro: e?.message || String(e) }; }

      // ── CANDIDATAS GRATUITAS, medidas DAQUI ──────────────────────────────
      // Nao adianta escolher fonte pela reputacao: a CoinGecko e a melhor API
      // de cripto que existe e nos recusa. O que decide e quem responde 200
      // deste IP.
      const SIGLA = { bitcoin: 'BTC', ethereum: 'ETH', pepe: 'PEPE', solana: 'SOL', btc: 'BTC', eth: 'ETH' };
      const sg = SIGLA[m.toLowerCase()] || m.toUpperCase();
      const candidatas = [
        ['binance_brl',  `https://api.binance.com/api/v3/ticker/24hr?symbol=${sg}BRL`],
        ['binance_usdt', `https://api.binance.com/api/v3/ticker/24hr?symbol=${sg}USDT`],
        ['coincap',      `https://api.coincap.io/v2/assets?search=${encodeURIComponent(m)}`],
        ['mercadobitcoin', `https://www.mercadobitcoin.net/api/${sg}/ticker/`],
        ['cryptocompare', `https://min-api.cryptocompare.com/data/price?fsym=${sg}&tsyms=BRL`],
      ];
      linha.candidatas = {};
      for (const [nome, url] of candidatas) {
        const t4 = Date.now();
        try {
          const r = await fetch(url);
          const txt = await r.text();
          linha.candidatas[nome] = { status: r.status, ms: Date.now() - t4, trecho: txt.slice(0, 130) };
        } catch (e) { linha.candidatas[nome] = { erro: String(e?.message || e).slice(0, 80) }; }
      }

      saida.push(linha);
    }
    return res.json({ ambiente: process.env.RENDER ? 'render' : 'local', cripto: saida });
  }

  // ── MODO SIMULAÇÃO: ?simular=<email> ──────────────────────────────────────
  //
  // ⚠️ POR QUE SIMULAR EM VEZ DE CLICAR NO BOTÃO. Pra provar que "Atualizar
  // cotações" funciona eu precisaria de um JWT de usuário — ou seja, entrar na
  // conta de um cliente. Não se faz isso pra testar. Aqui a MESMA cadeia roda
  // (lê os investimentos do grupo → cotação → câmbio → calcula o valor), e o
  // resultado volta como número **sem gravar uma linha**.
  //
  // É o que distingue "a função responde" de "o recurso funciona": o diag
  // anterior provava só a primeira coisa, e foi assim que o recurso ficou morto
  // em produção passando em todo teste.
  if (req.query.simular) {
    const t0 = Date.now();
    const { data: u } = await supabase.from('users')
      .select('id, email, grupo_ativo').eq('email', String(req.query.simular)).maybeSingle();
    if (!u) return res.status(404).json({ erro: 'email não encontrado' });

    const { data: invs } = await supabase.from('investimentos')
      .select('id, nome, ticker, tipo, quantidade, valor_aportado, valor_atual')
      .eq('grupo_id', u.grupo_ativo);

    const base = await moedaBaseDoGrupo(u.grupo_ativo);
    const linhas = [];
    for (const inv of invs || []) {
      if (!inv.ticker) { linhas.push({ ticker: null, nome: inv.nome, pulado: 'sem ticker' }); continue; }
      if (!['Ações', 'FIIs', 'ETFs', 'Cripto'].includes(inv.tipo)) {
        linhas.push({ ticker: inv.ticker, pulado: `tipo "${inv.tipo}" fora da lista` }); continue;
      }
      const c = inv.tipo === 'Cripto'
        ? await buscarCotacaoCripto(inv.ticker.toLowerCase())
        : await buscarCotacaoAcao(inv.ticker);
      if (!c || c.precoAtual == null) {
        // ⚠️ CRIPTO NAO PASSA PELO buscarCotacaoAcao, então o `ultimoErro` dele
        // estaria SUJO da iteração anterior. Ler o motivo errado foi o que me
        // fez ver "bloqueio_ip" em cripto e quase diagnosticar o Yahoo por um
        // problema da CoinGecko.
        linhas.push({
          ticker: inv.ticker, tipo: inv.tipo,
          falhou: inv.tipo === 'Cripto' ? 'cripto_sem_preco' : (buscarCotacaoAcao.ultimoErro || 'sem_cotacao'),
        });
        continue;
      }
      const fator = fatorCotacaoParaBase(c.moeda, base, await taxasParaBase([c.moeda], base));
      if (fator === null) { linhas.push({ ticker: inv.ticker, falhou: `sem câmbio ${c.moeda}→${base}` }); continue; }
      const novo = c.precoAtual * fator * (inv.quantidade || 0);
      linhas.push({
        ticker: inv.ticker, tipo: inv.tipo, preco: c.precoAtual, moeda: c.moeda,
        qtd: inv.quantidade, atualHoje: inv.valor_atual, ficaria: Number(novo.toFixed(2)),
        rent: inv.valor_aportado > 0 ? `${(((novo - inv.valor_aportado) / inv.valor_aportado) * 100).toFixed(1)}%` : null,
      });
    }
    const cotou = linhas.filter((l) => l.ficaria != null).length;
    const falhou = linhas.filter((l) => l.falhou).length;
    return res.json({
      email: u.email, moedaBase: base, ms: Date.now() - t0,
      resumo: `${cotou} cotaram, ${falhou} falharam, ${linhas.length - cotou - falhou} puladas`,
      gravaria: false, linhas,
    });
  }

  const YahooFinance = require('yahoo-finance2').default;
  const yf = new YahooFinance();
  try { yf.suppressNotices(['yahooSurvey']); } catch {}

  const tickers = String(req.query.ticker || 'PETR4.SA,VALE3.SA').split(',').map((t) => t.trim()).filter(Boolean);
  const saida = [];
  for (const t of tickers) {
    const t0 = Date.now();
    try {
      const q = await yf.quote(t, {}, { validateResult: false });
      saida.push({
        ticker: t, ok: true, ms: Date.now() - t0,
        preco: q?.regularMarketPrice ?? null, moeda: q?.currency || null,
      });
    } catch (e) {
      // O ERRO CRU, inclusive o status HTTP quando existe — é o que distingue
      // 429 (limite), 403 (bloqueio de IP), timeout e DNS.
      saida.push({
        ticker: t, ok: false, ms: Date.now() - t0,
        erro: e?.message || String(e),
        nome: e?.name || null,
        status: e?.response?.status ?? e?.status ?? null,
        corpo: typeof e?.response?.body === 'string' ? e.response.body.slice(0, 300) : null,
      });
    }
  }
  // Uma chamada crua, sem a lib, pra separar "a lib" de "a rede".
  let direto = null;
  try {
    const t0 = Date.now();
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/PETR4.SA?interval=1d&range=1d');
    direto = { status: r.status, ms: Date.now() - t0, trecho: (await r.text()).slice(0, 200) };
  } catch (e) { direto = { erro: e?.message || String(e) }; }

  // ⚠️ A CANDIDATA, MEDIDA DO MESMO LUGAR. Nao adianta a brapi responder na
  // minha maquina: o que derrubou o Yahoo foi bloqueio de IP de NUVEM, entao a
  // substituta tem de ser testada de dentro do Render antes de ser escolhida.
  let brapi = null;
  try {
    const t0 = Date.now();
    const h = process.env.BRAPI_TOKEN ? { Authorization: `Bearer ${process.env.BRAPI_TOKEN}` } : {};
    const r = await fetch('https://brapi.dev/api/v2/stocks/quote?symbols=PETR4,VALE3', { headers: h });
    const txt = await r.text();
    let preco = null;
    try { preco = JSON.parse(txt)?.results?.[0]?.data?.regularMarketPrice ?? null; } catch {}
    brapi = { status: r.status, ms: Date.now() - t0, comToken: !!process.env.BRAPI_TOKEN, preco, trecho: txt.slice(0, 180) };
  } catch (e) { brapi = { erro: e?.message || String(e) }; }

  // A BUSCA de ticker vai pelo mesmo caminho e sofre do mesmo 429 — sem ela o
  // cliente não acha o papel pra cadastrar. Medir as duas numa chamada só.
  let busca = null;
  try {
    const { buscarTickers } = require('../services/cotacoes');
    const t0 = Date.now();
    const r = await buscarTickers(String(req.query.q || 'petr'));
    busca = { ms: Date.now() - t0, quantos: r.length, primeiro: r[0] || null };
  } catch (e) { busca = { erro: e?.message || String(e) }; }

  // O que o fluxo REAL devolve hoje — é o número que o cliente vê na tela.
  let fluxoReal = null;
  try {
    const { buscarCotacaoAcao } = require('../services/cotacoes');
    const t0 = Date.now();
    const c = await buscarCotacaoAcao(tickers[0] || 'PETR4.SA');
    fluxoReal = { ticker: tickers[0] || 'PETR4.SA', ms: Date.now() - t0, preco: c?.precoAtual ?? null, nome: c?.nomeCompleto || null, motivo: buscarCotacaoAcao.ultimoErro ?? null };
  } catch (e) { fluxoReal = { erro: e?.message || String(e) }; }

  res.json({ ambiente: process.env.RENDER ? 'render' : 'local', node: process.version, fluxoReal, busca, brapi, yahooPelaLib: saida, yahooDireto: direto });
});

// GET /api/investimentos/buscar-ticker?q=PETR
router.get('/buscar-ticker', auth, async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json([]);
  const r = await buscarTickers(q);
  res.json(r);
});

// GET /api/investimentos/buscar-cripto?q=bit
router.get('/buscar-cripto', auth, async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (q.length < 2) return res.json([]);
  res.json(await buscarCriptos(q));
});

// GET /api/investimentos/cotacao?ticker=AAPL&tipo=acao|cripto
// Retorna o preço atual JÁ em reais (converte moeda estrangeira via câmbio) e,
// desde a migration 168, também NA MOEDA BASE do grupo (`precoBase`/`moedaBase`/
// `taxaBase`). Num grupo em real, `precoBase` é o próprio `precoBRL`.
router.get('/cotacao', auth, async (req, res) => {
  try {
    const ticker = (req.query.ticker || '').toString().trim();
    const tipo   = (req.query.tipo || '').toString().toLowerCase();
    if (!ticker) return res.json({});

    const base = await moedaBaseDoGrupo(req.authUser?.grupoAtivo || await getGrupoId(req));
    // Preço em real → base. Sem câmbio da base, os campos na base não vêm (a
    // tela pede o preço à mão em vez de preencher real como se fosse dólar).
    const naBase = async (precoBRL, taxaParaBRLDoAtivo) => {
      if (base === 'BRL') return { precoBase: precoBRL, moedaBase: base, ...(taxaParaBRLDoAtivo ? { taxaBase: taxaParaBRLDoAtivo } : {}) };
      const t = taxaEntre('BRL', base, await taxasParaBase(['BRL'], base));
      if (t === null) return {};
      return { precoBase: precoBRL * t, moedaBase: base, ...(taxaParaBRLDoAtivo ? { taxaBase: taxaParaBRLDoAtivo * t } : {}) };
    };

    if (tipo === 'cripto') {
      const c = await buscarCotacaoCripto(ticker.toLowerCase());
      if (c?.precoAtual == null) return res.json({});
      return res.json({ precoBRL: c.precoAtual, moeda: 'BRL', variacaoDia: c.variacaoDia ?? 0, ...(await naBase(c.precoAtual)) });
    }

    const c = await buscarCotacaoAcao(ticker);
    if (c?.precoAtual == null) {
      // ⚠️ DIZ POR QUE NÃO VEIO. A tela mostrava a mesma frase para "este papel
      // não tem cotação" e para "a chamada falhou agora" — e o cliente do
      // relato leu a segunda como se fosse a primeira, concluindo que a Sora
      // "não consegue ler a cotação". Com o motivo, a tela pode oferecer
      // "tentar de novo" em vez de mandar preencher à mão.
      // ⚠️ 'bloqueio_ip' ENTRA AQUI JUNTO COM A FALHA DE REDE. Ele não é 'este
      // papel não tem cotação' — o papel tem; quem nos recusou foi o provedor.
      // Dizer 'não tem cotação' seria mentir sobre o ativo e mandar o cliente
      // preencher à mão para sempre.
      const falhou = buscarCotacaoAcao.ultimoErro === 'falha_rede'
                  || buscarCotacaoAcao.ultimoErro === 'bloqueio_ip';
      const motivo = falhou ? 'falha_temporaria' : 'sem_cotacao';
      return res.json({ motivo });
    }
    const moeda = c.moeda || 'BRL';
    if (moeda === 'BRL') {
      return res.json({ precoBRL: c.precoAtual, moeda: 'BRL', variacaoDia: c.variacaoDia ?? 0, ...(await naBase(c.precoAtual)) });
    }
    // Ativo cotado JÁ na moeda base do grupo: nada a converter.
    const jaNaBase = moeda === base ? { precoBase: c.precoAtual, moedaBase: base } : {};
    // Moeda estrangeira → converte pra real.
    const taxa = await taxaParaBRL(moeda);
    if (!taxa) return res.json({ precoOriginal: c.precoAtual, moeda, ...jaNaBase }); // sem câmbio
    return res.json({
      precoBRL: c.precoAtual * taxa, moeda: 'BRL',
      precoOriginal: c.precoAtual, moedaOriginal: moeda, taxa,
      variacaoDia: c.variacaoDia ?? 0,
      ...(moeda === base ? jaNaBase : await naBase(c.precoAtual * taxa, taxa)),
    });
  } catch (err) {
    // ⚠️ ERA MUDO. Qualquer falha aqui virava `{}` e, na tela, "não achei a
    // cotação" — sem nenhum rastro de qual foi o problema. Quando um cliente
    // relatou exatamente isso, não havia log nenhum pra consultar.
    console.error('[investimentos/cotacao]', req.query?.ticker, '—', err.message);
    res.json({ motivo: 'falha_temporaria' });
  }
});

// ── INVESTIMENTOS ────────────────────────────────────────────────

// GET /api/investimentos/:phone
router.get('/:phone', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('investimentos')
      .select('*').eq('grupo_id', grupoId).order('created_at');
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/investimentos/:phone/movimentos?limite=300
//
// Aportes, resgates e proventos que o Open Finance devolve por investimento
// (migration 139). Alimenta a aba Aportes e o card de dividendos, que viviam
// vazios porque essa fonte nunca era chamada.
router.get('/:phone/movimentos', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const limite = Math.min(parseInt(req.query.limite, 10) || 300, 1000);

    const { data, error } = await supabase.from('investimento_movimentos')
      .select('*, investimentos(nome, ticker, tipo, instituicao)')
      .eq('grupo_id', grupoId)
      .order('data', { ascending: false })
      .limit(limite);

    // ⚠️ Migration 139 pendente devolve LISTA VAZIA, não 500. A aba depende
    // desta rota, e derrubá-la por causa de uma tabela que ainda não existe
    // levaria junto os aportes lançados à mão.
    if (error) return res.json({ movimentos: [], totais: null, pendente: true });

    // Totais por classe — é o que a tela mostra acima da lista.
    // ⚠️ `neutro` fica de FORA: transferência de custódia não é dinheiro
    // entrando nem saindo (ver CLASSE_MOVIMENTO no sync).
    const totais = { aporte: 0, resgate: 0, provento: 0, imposto: 0 };
    for (const m of data || []) {
      if (totais[m.classe] !== undefined) totais[m.classe] += Number(m.valor) || 0;
    }
    res.json({ movimentos: data || [], totais });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/investimentos/:phone/distribuicao
router.get('/:phone/distribuicao', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data: invs } = await supabase.from('investimentos')
      .select('tipo, valor_atual').eq('grupo_id', grupoId);

    const agrupado = {};
    let total = 0;
    (invs || []).forEach(i => {
      agrupado[i.tipo] = (agrupado[i.tipo] || 0) + i.valor_atual;
      total += i.valor_atual;
    });

    const distribuicao = Object.entries(agrupado).map(([tipo, valor]) => ({
      tipo, valor, percentual: total > 0 ? (valor / total) * 100 : 0
    })).sort((a,b) => b.valor - a.valor);

    res.json({ distribuicao, total });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos
//
// ⚠️ O `error` do insert É LIDO. Antes a rota fazia `const { data } = await
// ...insert()` e respondia `res.json(data)`: quando o insert falhava, `data`
// vinha null e o painel recebia **200 OK com null** — achava que salvou, fechava
// o modal e recarregava a lista vazia. Era o relato "não está salvando" SEM
// nenhuma mensagem de erro. A causa por trás era a CHECK constraint de `tipo`
// (migration 121), mas qualquer falha futura teria sumido do mesmo jeito.
router.post('/', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const {
      tipo, nome, ticker, quantidade, preco_unitario, valor_aportado, data_compra,
      is_reserva_emergencia, taxa_anual, data_vencimento, indexador, percentual_indexador,
    } = req.body;
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    if (!tipo || !nome) return res.status(400).json({ erro: 'Informe o tipo e o nome do investimento.' });

    const qtd   = parseFloat(quantidade) || 1;
    const preco = parseFloat(preco_unitario) || parseFloat(valor_aportado);
    const aporte = parseFloat(valor_aportado);
    if (!Number.isFinite(aporte)) return res.status(400).json({ erro: 'Informe o valor investido.' });

    const base = {
      grupo_id: grupoId, tipo, nome,
      ticker: ticker || null,
      quantidade: qtd, preco_unitario: preco,
      valor_aportado: aporte,
      valor_atual: qtd * preco,
      data_compra: data_compra || new Date().toISOString(),
    };
    const linha = { ...base };
    // Campos que o modal JÁ enviava e a rota descartava em silêncio — inclusive
    // `is_reserva_emergencia`, que é o que faz o tipo "Reserva" contar na aba
    // Reserva de emergência.
    const extras = {
      is_reserva_emergencia: is_reserva_emergencia === true || undefined,
      taxa_anual: taxa_anual != null ? parseFloat(taxa_anual) : undefined,
      data_vencimento: data_vencimento || undefined,
      indexador: indexador || undefined,
      percentual_indexador: percentual_indexador != null ? parseFloat(percentual_indexador) : undefined,
    };
    for (const [k, v] of Object.entries(extras)) if (v !== undefined) linha[k] = v;

    let { data, error } = await supabase.from('investimentos').insert(linha).select().single();

    // Coluna nova ainda sem migration → regrava só com o essencial, em vez de
    // perder o investimento inteiro (lição do CLAUDE.md).
    if (error && Object.keys(extras).some((k) => (error.message || '').includes(k))) {
      ({ data, error } = await supabase.from('investimentos').insert(base).select().single());
    }

    if (error) {
      // O CHECK de `tipo` era exatamente este caso: mensagem crua do Postgres
      // não ajuda ninguém, então traduz.
      const constraintTipo = /investimentos_tipo_check/i.test(error.message || '');
      console.error('[investimentos] insert falhou:', error.message);
      return res.status(constraintTipo ? 400 : 500).json({
        erro: constraintTipo
          ? `O tipo "${tipo}" ainda não está liberado no banco. Rode a migration sql/121_investimentos_tipo_check.sql.`
          : `Não consegui salvar: ${error.message}`,
      });
    }

    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

/**
 * PUT /api/investimentos/:id/valor — "meu CDB rendeu, o valor hoje é X".
 *
 * ⚠️ EXISTE SEPARADA DO PUT GENÉRICO DE PROPÓSITO. Aqui o `valor_aportado` não
 * é nem lido do corpo: ele é quanto a pessoa colocou do bolso, e mexer nele
 * apagaria o lucro em vez de registrá-lo. O PUT genérico aceita os dois campos
 * porque serve a outros usos (correção de cadastro); esta rota não dá essa
 * chance a um payload malformado.
 *
 * ⚠️ Renda fixa (CDB, LCI, Tesouro) não tem cotação pública, então era o ÚNICO
 * tipo sem caminho nenhum: ficava parado no valor de cadastro para sempre.
 */
router.put('/:id/valor', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { data: inv, error: erroLer } = await supabase.from('investimentos')
      .select('id, nome, ticker, valor_aportado, valor_atual, of_id, origem')
      .eq('id', req.params.id).eq('grupo_id', req.grupoId).maybeSingle();
    // ⚠️ Falha de LEITURA não vira "não encontrado": responder 404 faria a tela
    // dizer que o investimento sumiu por causa de um soluço de rede.
    if (erroLer) return res.status(500).json({ erro: `Não consegui ler o investimento: ${erroLer.message}` });
    if (!inv) return res.status(404).json({ erro: 'Investimento não encontrado.' });

    const recusa = recusaSeDoBanco(inv, 'ajuste de valor');
    if (recusa) return res.status(409).json(recusa);

    const plano = planoDeAtualizarValor(inv, req.body?.valor_atual);
    if (plano.erro) return res.status(400).json({ erro: plano.erro, motivo: plano.motivo });

    // ⚠️ O erro do update é LIDO. Descartá-lo responderia 200 com null e a tela
    // fecharia dizendo que salvou — o defeito das migrations 121 e 147.
    const { data, error } = await supabase.from('investimentos')
      .update(plano.patch).eq('id', inv.id).eq('grupo_id', req.grupoId).select().single();
    if (error) return res.status(500).json({ erro: `Não consegui atualizar: ${error.message}` });

    res.json({ ok: true, investimento: data, temporario: plano.temporario });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// PUT /api/investimentos/:id
// Mesmo problema do POST: o `error` era descartado e a edição "sumia" sem aviso.
router.put('/:id', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    // ⚠️ `is_reserva_emergencia` FALTAVA AQUI, e era metade do bug: a aba
    // Reserva dizia 'Edite um CDB de liquidez diária' e a edição descartava o
    // campo em silêncio — sem outro campo junto, a rota ainda respondia 400
    // 'Nada para atualizar'. Cliente premium ficou com a reserva zerada tendo
    // R$ 79.836,29 num fundo DI.
    const campos = ['nome','ticker','quantidade','preco_unitario','valor_atual','valor_aportado','is_reserva_emergencia','meta_id'];
    const update = {};
    campos.forEach(c => { if (req.body[c] !== undefined) update[c] = req.body[c]; });
    if (!Object.keys(update).length) return res.status(400).json({ erro: 'Nada para atualizar.' });

    // ⚠️ A TRAVA DO OPEN FINANCE FALTAVA AQUI. Aporte e resgate já a tinham;
    // o PUT não — e `upsertInvestimento` regrava quantidade, preço e valores a
    // cada sync, então a edição sumiria sozinha no dia seguinte. Medido: 632
    // dos 700 investimentos da base vêm do OF, ou seja, era quase todo mundo.
    //
    // ⚠️ `is_reserva_emergencia` e `meta_id` CONTINUAM LIBERADOS: são marcações
    // NOSSAS, o sync não as toca, e barrá-las quebraria a aba Reserva — que só
    // funciona porque a pessoa marca um investimento do banco como reserva
    // (migrations 147 e seguintes).
    const soNossas = Object.keys(update).every((c) => c === 'is_reserva_emergencia' || c === 'meta_id');
    if (!soNossas) {
      const { data: alvo } = await supabase.from('investimentos')
        .select('id, of_id, origem').eq('id', req.params.id).eq('grupo_id', req.grupoId).maybeSingle();
      const recusa = recusaSeDoBanco(alvo, 'ajuste');
      if (recusa) return res.status(409).json(recusa);
    }

    const { data, error } = await supabase.from('investimentos')
      .update(update).eq('id', req.params.id).eq('grupo_id', req.grupoId).select().single();
    if (error) {
      console.error('[investimentos] update falhou:', error.message);
      return res.status(500).json({ erro: `Não consegui atualizar: ${error.message}` });
    }
    // `single()` sem linha = id de outro grupo (ou apagado). 404 explícito em vez
    // de 200 com null.
    if (!data) return res.status(404).json({ erro: 'Investimento não encontrado.' });
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/investimentos/:id
router.delete('/:id', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    // ⚠️ LER O `error`. O client do Supabase NÃO lança em falha — devolve
    // `{ error }`. Sem esta checagem a rota respondia `{ ok: true }` mesmo sem
    // apagar nada, e o painel fechava o modal como se tivesse dado certo. É o
    // mesmo defeito que o POST/PUT tinham (corrigido em ago/2026 junto da 121).
    const { data, error } = await supabase.from('investimentos')
      .delete().eq('id', req.params.id).eq('grupo_id', req.grupoId).select('id');
    if (error) {
      console.error('[investimentos DELETE]', error.message);
      return res.status(500).json({ erro: error.message });
    }
    // Zero linhas = id inexistente ou de OUTRO grupo. Responder 200 aqui faria
    // o item sumir da tela e voltar no próximo carregamento.
    if (!data || !data.length) {
      return res.status(404).json({ erro: 'Investimento não encontrado.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[investimentos DELETE] exceção:', err.message);
    res.status(500).json({ erro: err.message });
  }
});

// ── APORTES ──────────────────────────────────────────────────────

// GET /api/investimentos/:phone/aportes
router.get('/:phone/aportes', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('aportes')
      .select('*, investimentos(nome)').eq('grupo_id', grupoId)
      .order('data', { ascending: false }).limit(50);
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos/aportes
router.post('/aportes', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, valor, investimento_id, descricao, quantidade } = req.body;
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    // ⚠️ LÊ O INVESTIMENTO ANTES DE GRAVAR QUALQUER COISA. É ele que diz se o
    // aporte pode acontecer (Open Finance) e qual é a posição de hoje — que é o
    // que o preço médio precisa. Antes a leitura vinha DEPOIS do insert, então
    // um investimento recusado já teria deixado linha no extrato.
    let inv = null;
    if (investimento_id) {
      const { data, error: eLer } = await supabase.from('investimentos')
        .select('id, nome, valor_aportado, valor_atual, quantidade, ticker, of_id, origem')
        .eq('id', investimento_id).eq('grupo_id', grupoId).maybeSingle();
      if (eLer) return res.status(500).json({ erro: `Não consegui ler o investimento: ${eLer.message}` });
      if (!data) return res.status(404).json({ erro: 'Investimento não encontrado.' });
      inv = data;
      const recusa = recusaSeDoBanco(inv, 'aporte');
      if (recusa) return res.status(409).json(recusa);
    }

    // Aritmética canônica (services/aporteInvestimento, `npm run eval:aporte`).
    // ⚠️ É AQUI QUE A QUANTIDADE ENTRA. Sem ela o aporte só somava dinheiro, e
    // em ativo com ticker o `atualizar-precos` (cotação × quantidade) apagava a
    // compra no refresh seguinte — virava prejuízo na tela.
    const calc = aplicarAporte(inv || {}, { valor, quantidade });
    if (!calc.ok) return res.status(400).json({ erro: calc.erro });
    const v = calc.aportado;

    const qtdInformada = calc.patch.quantidade !== undefined ? Number(quantidade) : null;
    const descricaoFinal = descricao || (qtdInformada
      ? `Aporte: ${qtdInformada} ${qtdInformada === 1 ? 'cota' : 'cotas'}${inv?.ticker ? ` de ${inv.ticker}` : ''}`
      : 'Aporte manual');

    // `tipo` NÃO é enviado de propósito: a coluna tem default 'aporte'
    // (migration 122), então isto continua funcionando antes de ela rodar.
    // ⚠️ O `error` É LIDO — esta rota tinha o mesmo defeito do POST de
    // investimento: `const { data } = insert()` e `res.json(data)` devolviam
    // 200 com null quando falhava, e o painel achava que tinha salvado.
    const { data: aporte, error: eAp } = await supabase.from('aportes').insert({
      grupo_id: grupoId, valor: v,
      investimento_id: investimento_id || null,
      descricao: descricaoFinal
    }).select().single();
    if (eAp) {
      console.error('[aportes] insert falhou:', eAp.message);
      return res.status(500).json({ erro: `Não consegui registrar o aporte: ${eAp.message}` });
    }

    // Atualiza o investimento vinculado
    let nomeInv = null;
    if (inv) {
      nomeInv = inv.nome;
      const { error: eUp } = await supabase.from('investimentos')
        .update({ ...calc.patch, ultima_atualizacao: new Date().toISOString() })
        .eq('id', investimento_id).eq('grupo_id', grupoId);
      if (eUp) {
        // Desfaz o extrato: aporte registrado sem efeito na posição é pior que
        // aporte nenhum — o extrato para de bater com a carteira e ninguém vê.
        await supabase.from('aportes').delete().eq('id', aporte.id);
        return res.status(500).json({ erro: `Não consegui atualizar o investimento: ${eUp.message}` });
      }
    }

    // Opcional: desconta de uma conta e registra a saída nas transações.
    let debito = null;
    if (req.body.wallet_id) {
      try {
        debito = await debitarConta({
          grupoId, walletId: req.body.wallet_id, valor: parseFloat(valor),
          categoria: 'Investimentos', observacao: `Aporte: ${nomeInv || descricao || 'investimento'}`,
          userId: req.userId,
        });
      } catch (e) { debito = { erro: e.message }; }
    }

    res.json({ ...aporte, debito });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos/resgates — tira dinheiro de um investimento.
//
// Relato de usuário: "não achei a opção de resgate de investimentos". Não
// achou porque não existia — só METAS tinham resgate.
//
// ⚠️ O abatimento é PROPORCIONAL (services/resgateInvestimento.js): mexer só
// no valor atual e deixar o aportado intacto faria um saque parcial virar
// "prejuízo" na tela. Travado em `npm run eval:resgate`.
router.post('/resgates', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { valor, investimento_id, descricao, wallet_id } = req.body;
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    if (!investimento_id) return res.status(400).json({ erro: 'Escolha de qual investimento é o resgate.' });

    const { data: inv, error: eInv } = await supabase.from('investimentos')
      .select('id, nome, valor_aportado, valor_atual, quantidade, of_id, origem')
      .eq('id', investimento_id).eq('grupo_id', grupoId).maybeSingle();
    if (eInv) return res.status(500).json({ erro: `Não consegui ler o investimento: ${eInv.message}` });
    if (!inv) return res.status(404).json({ erro: 'Investimento não encontrado.' });
    // Mesma regra do aporte: o sync do banco reescreveria isto no dia seguinte.
    const recusaResgate = recusaSeDoBanco(inv, 'resgate');
    if (recusaResgate) return res.status(409).json(recusaResgate);

    const { aplicarResgate } = require('../services/resgateInvestimento');
    const calc = aplicarResgate(inv, valor);
    if (!calc.ok) return res.status(400).json({ erro: calc.erro });

    // Extrato primeiro: se a linha do resgate falhar, nada foi alterado ainda.
    const linha = {
      grupo_id: grupoId, valor: calc.resgatado,
      investimento_id, tipo: 'resgate',
      descricao: descricao || `Resgate: ${inv.nome}`,
    };
    let { data: mov, error: eMov } = await supabase.from('aportes').insert(linha).select().single();
    // Migration 122 pendente (sem a coluna `tipo`) → o resgate NÃO pode entrar
    // como se fosse aporte, senão o extrato mente. Melhor recusar com instrução.
    if (eMov && /tipo/i.test(eMov.message || '')) {
      return res.status(400).json({
        erro: 'Resgate ainda não liberado no banco. Rode a migration sql/122_aportes_resgate.sql.',
      });
    }
    if (eMov) return res.status(500).json({ erro: `Não consegui registrar o resgate: ${eMov.message}` });

    const { error: eUp } = await supabase.from('investimentos')
      .update({ ...calc.patch, ultima_atualizacao: new Date().toISOString() })
      .eq('id', investimento_id).eq('grupo_id', grupoId);
    if (eUp) {
      // Desfaz o extrato pra não sobrar resgate registrado sem efeito nenhum.
      await supabase.from('aportes').delete().eq('id', mov.id);
      return res.status(500).json({ erro: `Não consegui atualizar o investimento: ${eUp.message}` });
    }

    // Opcional: o dinheiro volta pra uma conta (entrada marcada como
    // transferência — resgate não é renda nova, ver creditarConta).
    let credito = null;
    if (wallet_id) {
      try {
        const { creditarConta } = require('../services/contaDebito');
        credito = await creditarConta({
          grupoId, walletId: wallet_id, valor: calc.resgatado,
          categoria: 'Investimentos', observacao: `Resgate: ${inv.nome}`,
          userId: req.userId,
        });
      } catch (e) { credito = { erro: e.message }; }
    }

    res.json({ ...mov, zerou: calc.zerou, credito });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── METAS ────────────────────────────────────────────────────────

// GET /api/investimentos/:phone/metas
router.get('/:phone/metas', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('metas')
      .select('*').eq('grupo_id', grupoId);
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos/metas
// ⚠️ ROTA LEGADA E MORTA — respondia 200 com null.
//
// Ela insere `nome`, `prazo_anos`, `taxa_anual`, `aporte_mensal_sugerido` e
// `investimento_id`: CINCO colunas que não existem em `metas`. Como o insert era
// `const { data } = await ...` sem ler o `error`, a falha virava `data = null` e
// a resposta saía 200 — mesma família do bug corrigido na migration 121.
//
// As metas de verdade são as de `routes/metas.js` (/api/metas), com titulo /
// valor_objetivo / valor_atual + aportes. O vínculo com investimento agora vive
// em `investimentos.meta_id` (migration 147), gravado pelo PUT acima.
//
// Fica respondendo 410 em vez de sumir: se algo ainda chamar, queremos ver o
// erro no lugar de um sucesso falso.
router.post('/metas', auth, async (_req, res) => res.status(410).json({
  erro: 'Rota descontinuada. Use POST /api/metas para criar a meta e PUT /api/investimentos/:id com meta_id para atrelar um investimento.',
}));

router.post('/metas-legado-desativado', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, nome, valor_objetivo, prazo_anos, taxa_anual, investimento_id } = req.body;
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });

    const taxa = parseFloat(taxa_anual) || 10;
    const n    = parseFloat(prazo_anos) * 12;
    const jm   = Math.pow(1 + taxa/100, 1/12) - 1;
    let aporte = (parseFloat(valor_objetivo) * jm) / (Math.pow(1+jm,n) - 1);
    if (!isFinite(aporte)) aporte = parseFloat(valor_objetivo) / n;

    const { data } = await supabase.from('metas').insert({
      grupo_id: grupoId, nome,
      valor_objetivo: parseFloat(valor_objetivo),
      prazo_anos: parseFloat(prazo_anos),
      taxa_anual: taxa,
      aporte_mensal_sugerido: parseFloat(aporte.toFixed(2)),
      investimento_id: investimento_id || null
    }).select().single();

    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/investimentos/metas/:id
router.delete('/metas/:id', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    await supabase.from('metas').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── COTAÇÕES + RESERVA DE EMERGÊNCIA ─────────────────────────────

// POST /api/investimentos/atualizar-precos/:phone
router.post('/atualizar-precos/:phone', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    const { data: invs } = await supabase.from('investimentos').select('*').eq('grupo_id', grupoId);
    let atualizados = 0;
    // Moeda base do grupo (migration 168): a cotação, na moeda do ativo, vira a
    // moeda do grupo. Ativo cotado na base não faz ida de rede.
    const base = await moedaBaseDoGrupo(grupoId);

    for (const inv of invs || []) {
      if (!inv.ticker) continue;
      let cotacao = null;
      if (inv.tipo === 'Cripto') {
        cotacao = await buscarCotacaoCripto(inv.ticker.toLowerCase());
      } else if (['Ações', 'FIIs', 'ETFs'].includes(inv.tipo)) {
        cotacao = await buscarCotacaoAcao(inv.ticker);
      }
      if (!cotacao || cotacao.precoAtual == null) continue;
      // ⚠️ Sem câmbio pra base, NÃO grava: preço em outra moeda gravado como se
      //    fosse a base é número plausível e errado.
      const fator = fatorCotacaoParaBase(cotacao.moeda, base, await taxasParaBase([cotacao.moeda], base));
      if (fator === null) continue;

      const valorAtual = cotacao.precoAtual * fator * (inv.quantidade || 0);
      const divs = ['Ações', 'FIIs', 'ETFs'].includes(inv.tipo)
        ? await buscarDividendos(inv.ticker, inv.data_compra) * fator
        : 0;
      const valorTotal = valorAtual + (divs * (inv.quantidade || 0));
      const rent = inv.valor_aportado > 0 ? (valorTotal - inv.valor_aportado) / inv.valor_aportado : 0;

      await supabase.from('investimentos').update({
        valor_atual:           valorAtual,
        variacao_dia:          cotacao.variacaoDia ?? 0,
        rentabilidade:         rent,
        dividendos_acumulados: divs * (inv.quantidade || 0),
        ultima_atualizacao:    new Date().toISOString(),
      }).eq('id', inv.id);

      atualizados++;
      await new Promise(r => setTimeout(r, 600)); // rate limit
    }

    res.json({ atualizados, total: invs?.length || 0 });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/investimentos/caixinhas/:phone
// Caixinhas / cofrinhos vindos do Open Finance (saldos reservados).
//
// ⚠️ Esse dinheiro NÃO está no saldo da conta — a doc da Celcoin diz que
// `balance.available_amount` "não inclui (…) reservas de saldo". Por isso a
// aba mostra o total separado: somar junto ao saldo seria inventar, e não
// mostrar era esconder dinheiro do cliente.
//
// Leitura TOLERANTE: a tabela existe desde a 069, mas as colunas de remuneração
// são da 120. Se a migration não rodou, devolve o básico em vez de estourar
// (lição da casa: coluna nova em select de caminho crítico derruba a aba toda).
router.get('/caixinhas/:phone', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    const COMPLETO = 'id,nome,tipo,saldo,moeda,atualizado_em,indexador,indexador_pct,taxa_pre,periodicidade';
    let { data, error } = await supabase.from('of_caixinhas')
      .select(COMPLETO).eq('grupo_id', grupoId).order('saldo', { ascending: false });

    if (error) {
      const r2 = await supabase.from('of_caixinhas')
        .select('id,nome,tipo,saldo,moeda,atualizado_em').eq('grupo_id', grupoId)
        .order('saldo', { ascending: false });
      // Tabela ausente (069 pendente) → lista vazia, a aba só não mostra a seção.
      if (r2.error) return res.json({ caixinhas: [], total: 0 });
      data = r2.data;
    }

    const caixinhas = data || [];
    const total = caixinhas.reduce((s, c) => s + (Number(c.saldo) || 0), 0);
    res.json({ caixinhas, total: Math.round(total * 100) / 100 });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/investimentos/reserva/:phone
router.get('/reserva/:phone', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    const { data: config } = await supabase.from('reserva_emergencia_config')
      .select('*').eq('grupo_id', grupoId).maybeSingle();

    const { data: invs } = await supabase.from('investimentos')
      .select('valor_atual').eq('grupo_id', grupoId).eq('is_reserva_emergencia', true);
    const valorAtual = (invs || []).reduce((s, i) => s + (i.valor_atual || 0), 0);

    const seisMesesAtras = new Date();
    seisMesesAtras.setMonth(seisMesesAtras.getMonth() - 6);
    // ⚠️ TRANSFERÊNCIA NÃO É GASTO — e aqui ela estava entrando.
    // A rota somava todo `tipo='Gasto'` cru, sem a regra canônica do painel
    // (`ehTransferencia`, em services/resumoTransacoes.js). Pagamento de fatura
    // é gravado como Gasto + transferencia, então o dinheiro contava DUAS
    // vezes: a compra no cartão e a quitação da fatura.
    //
    // Medido num cliente: R$ 30.451,33 em 4 linhas inflavam o gasto médio de
    // R$ 27.198,80 para R$ 32.274,02 — e a meta de reserva de 12 meses de
    // R$ 326.385,58 para R$ 387.288,24. Sessenta mil reais de objetivo que não
    // existiam, num card que já diz 'CRÍTICO' em vermelho.
    const { data: gastos } = await supabase.from('transacoes')
      // `categoria` e `ignorar_em` (146) são lidas por ehTransferencia.
      .select('valor, transferencia, categoria, ignorar_em')
      .eq('grupo_id', grupoId).eq('tipo', 'Gasto')
      .gte('data', seisMesesAtras.toISOString().slice(0, 10));

    const semTransferencia = (gastos || []).filter((g) => !ehTransferencia(g));
    const totalGastos = semTransferencia.reduce((s, g) => s + (g.valor || 0), 0);
    const gastoTransacoes = totalGastos / 6;

    // ── PARCELAS DE DÍVIDA QUE NÃO VIRARAM TRANSAÇÃO ─────────────────────────
    //
    // Relato de cliente (26/09/2026): "na parte de conta de reserva ele não
    // está considerando o que tem em dívidas e parcelas". Na conta dele havia
    // R$ 6.296,91/mês de financiamento — mais que todo o resto do custo de
    // vida — sem um único pagamento lançado. Ver `services/custoMensalDividas`
    // pra por que a regra é estreita (contar em dobro é pior que o bug).
    //
    // ⚠️ Leitura TOLERANTE: se falhar, a reserva volta a ser exatamente o que
    // era. Uma consulta acessória não pode derrubar o card inteiro.
    let extraDividas = { parcelaMensal: 0, consideradas: [], jaNosGastos: [] };
    const incluirDividas = config?.incluir_dividas !== false; // default: sim
    if (incluirDividas) {
      try {
        const { data: divs } = await supabase.from('dividas')
          .select('id, titulo, credor, tipo, origem, status, valor_parcela, parcelas_pagas, parcelas_total')
          .eq('grupo_id', grupoId);
        extraDividas = custoMensalDividas({ dividas: divs || [], transacoes: semTransferencia });
      } catch { /* mantém zerado */ }
    }

    const gastoMedio  = gastoTransacoes + extraDividas.parcelaMensal;
    const mesesObj    = config?.meses_objetivo || 6;
    const objetivo    = gastoMedio * mesesObj;
    const pct         = objetivo > 0 ? Math.min((valorAtual / objetivo) * 100, 100) : 0;
    const mesesCob    = gastoMedio > 0 ? valorAtual / gastoMedio : 0;

    res.json({
      valorAtual,
      gastoMedioMensal: gastoMedio,
      mesesObjetivo:    mesesObj,
      valorObjetivo:    objetivo,
      percentual:       pct,
      mesesCobertos:    mesesCob,
      // Composição — é o que permite à tela EXPLICAR o número em vez de só
      // exibi-lo. Sem isso o cliente veria a meta subir sem saber por quê.
      gastoTransacoes,
      incluirDividas,
      parcelasDividas:  extraDividas.parcelaMensal,
      dividasNoCusto:   extraDividas.consideradas,
      dividasJaNosGastos: extraDividas.jaNosGastos.length,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/investimentos/reserva/:phone
router.post('/reserva/:phone', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { meses_objetivo, incluir_dividas } = req.body;
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Grupo não encontrado.' });

    // ⚠️ `meses_objetivo` só entra no patch quando VEIO no corpo. O toggle de
    // dívidas manda só o próprio campo, e um `|| 6` cego devolveria a meta de
    // quem escolheu 12 meses para 6 sem ninguém pedir.
    const patch = { grupo_id: grupoId, updated_at: new Date().toISOString() };
    if (meses_objetivo !== undefined) patch.meses_objetivo = parseInt(meses_objetivo, 10) || 6;
    if (incluir_dividas !== undefined) patch.incluir_dividas = incluir_dividas === true;

    const { error } = await supabase.from('reserva_emergencia_config')
      .upsert(patch, { onConflict: 'grupo_id' });

    // ⚠️ O ERRO É LIDO. `incluir_dividas` vem da migration 176; sem ela o
    // upsert falha e responder `ok` deixaria a tela dizendo que salvou com o
    // toggle voltando sozinho no próximo carregamento — a família de bug das
    // migrations 121/147.
    if (error) {
      if (/incluir_dividas/.test(error.message || '')) {
        return res.status(500).json({ erro: 'Rode a migration 176 (incluir_dividas).' });
      }
      return res.status(500).json({ erro: error.message });
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/investimentos/:phone/patrimonio — evolução histórica
router.get('/:phone/patrimonio', auth, exigirPlano('kit', 'premium', 'platinum'), exigirPermissao('admin', 'escrita', 'leitura'), async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('patrimonio_historico')
      .select('*').eq('grupo_id', grupoId)
      .order('data', { ascending: true }).limit(365);
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;