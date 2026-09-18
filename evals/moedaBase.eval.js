// =============================================================================
// EVAL — moeda BASE do grupo (Fase 5 do plano, sora-frontend/docs/PLANO-MOEDA-BASE.md)
//
// `transacoes.valor` passou de "SEMPRE BRL" pra "SEMPRE na moeda base do grupo"
// (migration 168). O erro caro aqui tem duas caras, e as duas são CALADAS:
//
//   1. Grupo em REAL mudar de comportamento. São todos os 217 grupos de hoje.
//      A seção 1 compara as funções novas com uma CÓPIA CONGELADA das antigas,
//      caso a caso, e a seção 5 passa pela rota real de lançamento.
//   2. Grupo em DÓLAR converter pro real. O número sai plausível (é só uma
//      multiplicação a mais) e fica CONGELADO na linha pra sempre.
//
// Tudo com Supabase e cotação FALSOS em memória — nenhuma ida de rede.
//
// Rodar:  npm run eval:moeda-base
// =============================================================================
const path = require('path');
// handlers/parcelas → handlers/transacoes → services/ia instancia o cliente da
// OpenAI no require. Nenhuma chamada é feita aqui.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-eval-sem-rede';

const falhas = [];
const eq = (a, b, m) => {
  const ja = JSON.stringify(a); const jb = JSON.stringify(b);
  if (ja !== jb) falhas.push(`${m}\n      esperado: ${jb}\n      veio:     ${ja}`);
};
const ok = (c, m) => { if (!c) falhas.push(m); };

// Cotação em BRL de 1 unidade (a mesma medida na base em 15/09/2026).
const TAXAS = { USD: 5.1435, NOK: 0.5515, EUR: 6.0 };
const cent = (v) => Math.round(v * 100) / 100;

// ── Supabase falso (mesmo desenho de evals/quitacao.eval.js) ─────────────────
function criarBanco(inicial, opcoes = {}) {
  const tabelas = { grupos: [], wallets: [], transacoes: [], recorrencias: [], categorias: [], cotacoes_moeda: [],
    ...JSON.parse(JSON.stringify(inicial)) };
  const leituras = {};
  let seq = 0;
  function from(nome) {
    const filtros = [];
    let modo = 'select', payload = null, retornar = false, unica = null, colunas = '*';
    const api = {
      select(c) { if (modo !== 'select') retornar = true; colunas = c || '*'; return api; },
      insert(p) { modo = 'insert'; payload = p; return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      upsert(p) { modo = 'upsert'; payload = p; return api; },
      delete() { modo = 'delete'; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      neq(c, v) { filtros.push((r) => r[c] !== v); return api; },
      // `%` vira curinga (antecipar parcela busca `%termo%`); sem `%`, igualdade
      // sem caixa — o que as seções anteriores já usavam.
      ilike(c, v) {
        const padrao = String(v ?? '').toLowerCase();
        const re = new RegExp(`^${padrao.split('%').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        filtros.push((r) => re.test(String(r[c] ?? '').toLowerCase()));
        return api;
      },
      is(c, v) { filtros.push((r) => (r[c] ?? null) === v); return api; },
      // `not(col, "in", '("a","b")')` é como a reconciliação apaga o que o banco
      // não mandou mais. Ignorá-lo apagava TUDO, inclusive o que acabou de entrar.
      not(c, op, v) {
        if (op === 'in') {
          const fora = new Set(String(v).replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')));
          filtros.push((r) => !fora.has(String(r[c])));
          return api;
        }
        filtros.push((r) => (op === 'is' ? (r[c] ?? null) !== v : true));
        return api;
      },
      in(c, arr) { const s = new Set(arr); filtros.push((r) => s.has(r[c])); return api; },
      filter() { return api; }, gte() { return api; }, lte() { return api; }, lt() { return api; },
      order() { return api; },
      limit() { return api; }, range() { return api; },
      single() { unica = 'single'; return api; },
      maybeSingle() { unica = 'maybe'; return api; },
      then(res, rej) { return Promise.resolve().then(executar).then(res, rej); },
    };
    // ⚠️ O SELECT PROJETA AS COLUNAS, como o banco de verdade. Devolver a linha
    // inteira escondia o defeito de ler uma coluna que a query não pediu (foi o
    // caso do Oráculo, que somava contas em dólar como real por não pedir `moeda`).
    function projetar(r) {
      if (typeof colunas !== 'string' || colunas.includes('*') || colunas.includes('(')) return { ...r };
      const o = {};
      for (const c of colunas.split(',').map((s) => s.trim()).filter(Boolean)) o[c] = r[c] === undefined ? null : r[c];
      return o;
    }
    function responder(linhas) {
      if (unica === 'single') return linhas.length === 1 ? { data: projetar(linhas[0]), error: null } : { data: null, error: { message: 'single' } };
      if (unica === 'maybe') return linhas.length > 1 ? { data: null, error: { message: 'multiple' } } : { data: linhas[0] ? projetar(linhas[0]) : null, error: null };
      return { data: linhas.map(projetar), error: null };
    }
    function executar() {
      if (modo === 'select') leituras[nome] = (leituras[nome] || 0) + 1;
      if (opcoes.erroEm && opcoes.erroEm[nome] && modo === 'select') return { data: null, error: { message: opcoes.erroEm[nome] } };
      const t = tabelas[nome] || (tabelas[nome] = []);
      if (modo === 'insert') {
        const novas = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: `${nome}-${++seq}`, ...p }));
        t.push(...novas);
        return responder(novas);
      }
      if (modo === 'upsert') {
        const linhas = Array.isArray(payload) ? payload : [payload];
        for (const p of linhas) {
          const ja = nome === 'wallets' ? t.find((r) => r.grupo_id === p.grupo_id && r.nome === p.nome) : null;
          if (ja) Object.assign(ja, p); else t.push({ id: `${nome}-${++seq}`, ...p });
        }
        return { data: null, error: null };
      }
      const alvo = t.filter((r) => filtros.every((f) => f(r)));
      if (modo === 'update') { alvo.forEach((r) => Object.assign(r, payload)); return retornar || unica ? responder(alvo) : { data: null, error: null }; }
      if (modo === 'delete') { tabelas[nome] = t.filter((r) => !alvo.includes(r)); return { data: null, error: null }; }
      return responder(alvo);
    }
    return api;
  }
  return { client: { from }, tabelas, leituras };
}

// Carrega módulos REAIS com banco e cotação falsos (cache de require zerado a
// cada cenário: o cache de câmbio e o da base são estado de módulo).
function carregar(banco, cotacoesChamadas = [], mercado = {}, celcoin = null) {
  const raiz = path.resolve(__dirname, '../src');
  const fixar = (rel, exports) => {
    const f = path.join(raiz, rel);
    require.cache[f] = { id: f, filename: f, loaded: true, exports };
  };
  for (const k of Object.keys(require.cache)) if (k.startsWith(raiz)) delete require.cache[k];
  fixar('db/supabase.js', banco.client);
  fixar('services/cotacoes.js', {
    taxaParaBRLDetalhe: async (m) => { cotacoesChamadas.push(m); return { taxa: TAXAS[m] ?? null, fonte: 'eval' }; },
    taxaParaBRL: async (m) => (m === 'BRL' ? 1 : TAXAS[m] ?? null),
    buscarCotacaoAcao: async (t) => mercado[t] || null,
    buscarCotacaoCripto: async (t) => mercado[t] || null,
    buscarDividendos: async (t) => (mercado[t] && mercado[t].dividendos) || 0,
    buscarTickers: async () => [], buscarCriptos: async () => [], listarCriptos: async () => [],
  });
  fixar('middlewares/plano.js', { exigirPlano: () => (req, res, next) => next() });
  if (celcoin) fixar('services/polpCelcoin.js', celcoin);
  fixar('services/duplicadas.js', { avisarDuplicadasEmBackground() {} });
  fixar('middlewares/auth.js', (req, res, next) => next());
  fixar('middlewares/permissao.js', { exigirPermissao: () => (req, res, next) => next() });
  fixar('services/limites.js', { verificarLimiteEmBackground() {}, verificarLimite: async () => {} });
  fixar('services/mensageiro.js', { enviarTexto: async () => {}, enviarMenu: async () => {}, enviarImagem: async () => {}, enviarBotaoLink: async () => {} });
  return (rel) => require(path.join(raiz, rel));
}

function rota(router, metodo, caminho) {
  const layer = router.stack.find((l) => l.route && l.route.path === caminho && l.route.methods[metodo]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function chamar(h, req) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await h({ params: {}, query: {}, body: {}, authUser: { id: 'u1' }, userId: 'u1', ...req }, res);
  return res;
}

// ── Cópia CONGELADA das funções de antes (git HEAD 319e8ae) ──────────────────
const ANTIGO = (() => {
  const normalizarMoeda = (m) => { const s = String(m || '').trim().toUpperCase(); return ({ BRL: 1, USD: 1, EUR: 1, GBP: 1, CHF: 1, CAD: 1, AUD: 1, JPY: 1, ARS: 1, MXN: 1, CLP: 1, NOK: 1 })[s] ? s : 'BRL'; };
  function paraBRL(valor, moeda, tabela) {
    const v = Number(valor) || 0; const m = normalizarMoeda(moeda);
    if (m === 'BRL') return v;
    const t = tabela ? tabela[m] : null;
    if (!t || !Number.isFinite(t)) return null;
    return v * t;
  }
  const saldoEmBRL = (w, t) => paraBRL(w?.saldo, w?.moeda, t);
  function somarSaldos(ws, t) {
    let total = 0; let semCambio = 0;
    for (const w of ws || []) { const v = saldoEmBRL(w, t); if (v === null) { semCambio++; continue; } total += v; }
    return { total, semCambio };
  }
  function camposTransacao(valorNativo, moeda, tabela) {
    const m = normalizarMoeda(moeda); const v = Number(valorNativo) || 0;
    if (m === 'BRL') return { valor: v, moeda: null, valor_moeda: null, taxa_brl: null };
    const t = tabela ? tabela[m] : null;
    if (!t || !Number.isFinite(t)) return { valor: v, moeda: m, valor_moeda: v, taxa_brl: null };
    return { valor: Math.round(v * t * 100) / 100, moeda: m, valor_moeda: v, taxa_brl: t };
  }
  return { paraBRL, somarSaldos, camposTransacao };
})();

(async () => {
  // ── 1. GRUPO EM REAL: idêntico ao código de antes ──────────────────────────
  console.log('── 1. base BRL: as funções novas dão exatamente o que as antigas davam ──');
  {
    const M = carregar(criarBanco({}))('services/moeda.js');
    const valores = [0, 1, 50, 200, 4090.34, 1234.567, 0.005, -10, NaN, '12.5', null, undefined, 1e9];
    const moedas = ['BRL', 'USD', 'NOK', 'EUR', 'JPY', 'CLP', 'xyz', null, undefined, ' usd '];
    const tabelas = [{}, null, undefined, { ...TAXAS }, { USD: 0 }, { USD: NaN }, { USD: -2 }, { USD: Infinity }, { NOK: 0.55032 }];
    let n = 0;
    for (const v of valores) for (const m of moedas) for (const t of tabelas) {
      eq(M.camposTransacao(v, m, t), ANTIGO.camposTransacao(v, m, t), `camposTransacao(${v}, ${m}, ${JSON.stringify(t)}) sem base`);
      eq(M.camposTransacao(v, m, t, 'BRL'), ANTIGO.camposTransacao(v, m, t), `camposTransacao(${v}, ${m}, ${JSON.stringify(t)}, 'BRL')`);
      eq(M.paraBase(v, m, 'BRL', t), ANTIGO.paraBRL(v, m, t), `paraBase(${v}, ${m}, BRL)`);
      n += 3;
    }
    const carteiras = [
      [], [{ saldo: 10 }], [{ saldo: 1000, moeda: 'BRL' }, { saldo: 4090.34, moeda: 'NOK' }],
      [{ saldo: 6834.56, moeda: 'USD' }, { saldo: -50, moeda: 'BRL' }, { saldo: 3, moeda: 'CHF' }],
    ];
    for (const ws of carteiras) for (const t of tabelas) {
      eq(M.somarSaldos(ws, t), ANTIGO.somarSaldos(ws, t), `somarSaldos(${JSON.stringify(ws)}, ${JSON.stringify(t)}) sem base`);
      eq(M.somarSaldos(ws, t, 'BRL'), ANTIGO.somarSaldos(ws, t), `somarSaldos(...) base BRL`);
      n += 2;
    }
    ok(!M.ehEstrangeira('BRL') && M.ehEstrangeira('USD') && !M.ehEstrangeira(null), 'ehEstrangeira sem base = comparar com real');
    console.log(`  ok (${n} comparações)`);
  }

  // ── 2. GRUPO EM DÓLAR: converte pra dólar, nunca pro real ──────────────────
  console.log('── 2. base USD/NOK: a conversão vai pra base ──');
  {
    const M = carregar(criarBanco({}))('services/moeda.js');
    const tUSD_NOK = TAXAS.NOK / TAXAS.USD;
    eq(M.camposTransacao(50, 'USD', TAXAS, 'USD'), { valor: 50, moeda: null, valor_moeda: null, taxa_brl: null }, 'conta em dólar num grupo em dólar: linha sem campos de moeda');
    eq(M.camposTransacao(514.35, 'BRL', TAXAS, 'USD'), { valor: 100, moeda: 'BRL', valor_moeda: 514.35, taxa_brl: 1 / TAXAS.USD }, '⚠️ conta em REAL num grupo em dólar: R$ 514,35 = US$ 100 (moeda BRL registrada)');
    eq(M.camposTransacao(200, 'NOK', TAXAS, 'USD'), { valor: cent(200 * tUSD_NOK), moeda: 'NOK', valor_moeda: 200, taxa_brl: tUSD_NOK }, 'coroa num grupo em dólar: taxa cruzada pelo real');
    eq(M.camposTransacao(200, 'USD', TAXAS, 'NOK').valor, cent(200 * TAXAS.USD / TAXAS.NOK), 'dólar num grupo em coroa');
    eq(M.camposTransacao(200, 'NOK', { NOK: 0.5515 }, 'USD'), { valor: 200, moeda: 'NOK', valor_moeda: 200, taxa_brl: null }, '⚠️ sem a cotação da BASE: provisório com a moeda registrada, nunca taxa 1 silenciosa');
    eq(M.camposTransacao(1000, 'USD', TAXAS, 'JPY'), { valor: 1000, moeda: 'USD', valor_moeda: 1000, taxa_brl: null }, 'base em iene sem cotação do iene: provisório, nunca convertido pela metade');
    eq(M.camposTransacao(10, 'USD', { USD: 5.1435, JPY: 0.035 }, 'JPY').valor, Math.round(10 * 5.1435 / 0.035), 'base em iene arredonda na UNIDADE (sem centavos)');

    const ws = [{ saldo: 1000, moeda: 'USD' }, { saldo: 5143.5, moeda: 'BRL' }, { saldo: 4090.34, moeda: 'NOK' }, { saldo: 7, moeda: 'CHF' }];
    const s = M.somarSaldos(ws, TAXAS, 'USD');
    eq(cent(s.total), cent(1000 + 1000 + 4090.34 * tUSD_NOK), 'saldo somado em DÓLAR');
    eq(s.semCambio, 1, 'CHF sem câmbio fica de fora e é CONTADO — nunca vira 0');
    ok(M.ehEstrangeira('BRL', 'USD') && !M.ehEstrangeira('usd', 'USD'), 'estrangeira é relativo à base');
  }
  console.log('  ok');

  // ── 3. moedaBaseDoGrupo: cache, erro e migration ausente ───────────────────
  console.log('── 3. leitura da base: cache de 10 min, erro nunca vira real ──');
  {
    const agora = Date.now; let relogio = 1_000_000; Date.now = () => relogio;
    try {
      const b = criarBanco({ grupos: [{ id: 'gUSD', moeda_base: 'USD' }, { id: 'gVazio', moeda_base: '' }] });
      const M = carregar(b)('services/moeda.js');
      eq(await M.moedaBaseDoGrupo('gUSD'), 'USD', 'lê a base');
      eq(await M.moedaBaseDoGrupo('gUSD'), 'USD', 'segunda leitura');
      eq(b.leituras.grupos, 1, '⚠️ a segunda leitura sai do CACHE (egress é contagem de requisição)');
      relogio += 10 * 60 * 1000 + 1;
      await M.moedaBaseDoGrupo('gUSD');
      eq(b.leituras.grupos, 2, 'depois de 10 min lê de novo');
      M.esquecerMoedaBase('gUSD');
      await M.moedaBaseDoGrupo('gUSD');
      eq(b.leituras.grupos, 3, 'esquecerMoedaBase força a releitura (quem trocar a base chama isto)');
      eq(await M.moedaBaseDoGrupo('gVazio'), 'BRL', 'base vazia é real');
      eq(await M.moedaBaseDoGrupo(null), 'BRL', 'sem grupo é real');

      // Erro de rede com cache velho: fica com o velho.
      const b2 = criarBanco({ grupos: [{ id: 'gUSD', moeda_base: 'USD' }] });
      const M2 = carregar(b2)('services/moeda.js');
      await M2.moedaBaseDoGrupo('gUSD');
      relogio += 11 * 60 * 1000;
      b2.client.from = ((orig) => (nome) => {
        if (nome !== 'grupos') return orig(nome);
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'fetch failed' } }) }) }) };
      })(b2.client.from);
      eq(await M2.moedaBaseDoGrupo('gUSD'), 'USD', '⚠️ soluço de rede com cache velho: continua em DÓLAR, não cai pra real');

      // Migration 168 ausente: real, sem insistir.
      const b3 = criarBanco({}, { erroEm: { grupos: 'column grupos.moeda_base does not exist' } });
      const M3 = carregar(b3)('services/moeda.js');
      eq(await M3.moedaBaseDoGrupo('gX'), 'BRL', 'sem a 168 é real');
      await M3.moedaBaseDoGrupo('gY');
      eq(b3.leituras.grupos, 1, 'sem a 168 não insiste a cada chamada');
    } finally { Date.now = agora; }
  }
  console.log('  ok');

  // ── 4. Lista de carteiras (/api/wallets e /api/dashboard) ──────────────────
  console.log('── 4. comSaldoNaBase: campos novos, antigos intactos ──');
  {
    let chamadas = [];
    const M = carregar(criarBanco({}), chamadas)('services/moeda.js');
    const soReal = [{ id: 'a', nome: 'Nubank', saldo: 1000, moeda: 'BRL' }, { id: 'b', nome: 'Velha', saldo: '12.5' }];
    eq(await M.comSaldoNaBase(soReal, 'BRL'), [
      { id: 'a', nome: 'Nubank', saldo: 1000, moeda: 'BRL', saldo_brl: 1000, moeda_base: 'BRL', saldo_base: 1000 },
      { id: 'b', nome: 'Velha', saldo: '12.5', moeda: 'BRL', saldo_brl: 12.5, moeda_base: 'BRL', saldo_base: 12.5 },
    ], 'grupo em real sem conta estrangeira: os campos de antes + o espelho na base');
    eq(chamadas.length, 0, '⚠️ e SEM ida de rede nenhuma (99% dos grupos)');

    chamadas = [];
    const M2 = carregar(criarBanco({}), chamadas)('services/moeda.js');
    const mista = [{ id: 'a', saldo: 1000, moeda: 'BRL' }, { id: 'n', saldo: 4090.34, moeda: 'NOK' }];
    const r = await M2.comSaldoNaBase(mista, 'BRL');
    eq(r[1].saldo_brl, 4090.34 * TAXAS.NOK, 'saldo_brl da coroa como antes');
    eq(r[1].saldo_base, r[1].saldo_brl, 'em grupo em real, saldo_base = saldo_brl');
    eq(r[1].taxa_base, r[1].taxa_brl, 'e taxa_base = taxa_brl');

    const M3 = carregar(criarBanco({}), [])('services/moeda.js');
    const emDolar = await M3.comSaldoNaBase([
      { id: 'c', saldo: 1000, moeda: 'USD' }, { id: 'nu', saldo: 5143.5, moeda: 'BRL' }, { id: 'w', saldo: 4090.34, moeda: 'NOK' },
    ], 'USD');
    eq(emDolar.map((w) => cent(w.saldo_base)), [1000, 1000, cent(4090.34 * TAXAS.NOK / TAXAS.USD)], 'grupo em dólar: tudo somável em dólar');
    eq(emDolar[0].saldo_brl, 1000 * TAXAS.USD, 'saldo_brl continua sendo REAL de verdade (cache antigo)');
    eq(emDolar.every((w) => w.moeda_base === 'USD'), true, 'moeda_base vai junto');
  }
  console.log('  ok');

  // ── 5. Rota REAL de lançamento do painel ──────────────────────────────────
  console.log('── 5. POST /api/transacoes: real idêntico, dólar convertendo pra dólar ──');
  {
    const cenario = () => ({
      grupos: [{ id: 'gBRL', moeda_base: 'BRL' }, { id: 'gUSD', moeda_base: 'USD' }],
      wallets: [
        { id: 'w-nu', grupo_id: 'gBRL', nome: 'Nubank', tipo: 'Corrente', saldo: 1000, moeda: 'BRL' },
        { id: 'w-wise', grupo_id: 'gBRL', nome: 'Wise', tipo: 'Corrente', saldo: 4090.34, moeda: 'NOK' },
        { id: 'u-chase', grupo_id: 'gUSD', nome: 'Chase', tipo: 'Corrente', saldo: 1000, moeda: 'USD' },
        { id: 'u-nu', grupo_id: 'gUSD', nome: 'Nubank', tipo: 'Corrente', saldo: 5000, moeda: 'BRL' },
        { id: 'u-wise', grupo_id: 'gUSD', nome: 'Wise', tipo: 'Corrente', saldo: 4090.34, moeda: 'NOK' },
      ],
    });
    const b = criarBanco(cenario());
    const R = carregar(b)('routes/transacoes.js');
    const post = rota(R, 'post', '/');
    const lancar = (grupoId, carteira_nome, valor) => chamar(post, { grupoId, body: { tipo: 'Gasto', categoria: 'Mercado', valor, carteira_nome, data: '2026-09-01' } });
    const w = (id) => cent(b.tabelas.wallets.find((x) => x.id === id).saldo);

    const r1 = await lancar('gBRL', 'Nubank', 50);
    eq([r1.body.valor, 'moeda' in r1.body, w('w-nu')], [50, false, 950], 'real: linha sem colunas de moeda, saldo −50');
    const r2 = await lancar('gBRL', 'Wise', 200);
    eq([r2.body.valor, r2.body.moeda, r2.body.valor_moeda, r2.body.taxa_brl, w('w-wise')],
      [ANTIGO.camposTransacao(200, 'NOK', TAXAS).valor, 'NOK', 200, TAXAS.NOK, 3890.34], 'real com conta em coroa: IGUAL ao código antigo; saldo anda pelo nativo');

    const r3 = await lancar('gUSD', 'Chase', 50);
    eq([r3.body.valor, 'moeda' in r3.body, w('u-chase')], [50, false, 950], 'dólar em conta dólar: linha limpa');
    const r4 = await lancar('gUSD', 'Nubank', 514.35);
    eq([r4.body.valor, r4.body.moeda, r4.body.valor_moeda, w('u-nu')], [100, 'BRL', 514.35, 4485.65], '⚠️ grupo em dólar, conta em real: grava US$ 100 e tira R$ 514,35 da conta');
    const r5 = await lancar('gUSD', 'Wise', 200);
    eq([r5.body.valor, r5.body.moeda], [cent(200 * TAXAS.NOK / TAXAS.USD), 'NOK'], 'grupo em dólar, conta em coroa: taxa cruzada');
    const r6 = await lancar('gUSD', 'Conta Que Não Existe', 30);
    eq([r6.body.valor, 'moeda' in r6.body, r6.body.carteira_nome], [30, false, 'Dinheiro'], '⚠️ conta inexistente vira Dinheiro NA BASE — não é lida como real');

    // EDITAR o valor (PUT): o original anda junto e o saldo anda pelo original.
    const put = rota(R, 'put', '/:id');
    const editar = (grupoId, id, valor) => chamar(put, { grupoId, params: { id }, body: { valor } });
    const linha = (id) => b.tabelas.transacoes.find((t) => t.id === id);
    const e1 = await editar('gBRL', r1.body.id, 60);
    eq([e1.statusCode, linha(r1.body.id).valor, 'valor_moeda' in linha(r1.body.id), w('w-nu')], [200, 60, false, 940],
      'editar lançamento em real: saldo −10 e nenhuma coluna de moeda aparece, como antes');
    await editar('gBRL', r2.body.id, cent(r2.body.valor * 2));
    eq([linha(r2.body.id).valor_moeda, w('w-wise')], [400, 3690.34],
      '⚠️ editar o lançamento da conta em coroa: o original vai a 400 kr e o saldo anda 200 kr — não 110 "reais" em coroa');
    await editar('gUSD', r4.body.id, 110);
    eq([linha(r4.body.id).valor, linha(r4.body.id).valor_moeda, w('u-nu')],
      [110, Math.round((110 / (1 / TAXAS.USD)) * 100) / 100, cent(5000 - Math.round((110 / (1 / TAXAS.USD)) * 100) / 100)],
      '⚠️ grupo em dólar, conta em real: US$ 100 → US$ 110 leva o original pela MESMA taxa, e o saldo em real acompanha');
  }
  console.log('  ok');

  // ── 6. Mover de conta, conta fixa, cron de câmbio, quitação, rateio, cartões
  console.log('── 6. os outros caminhos que gravam ou somam dinheiro ──');
  {
    const b = criarBanco({
      grupos: [{ id: 'gBRL', moeda_base: 'BRL' }, { id: 'gUSD', moeda_base: 'USD' }],
      wallets: [
        { id: 'u-chase', grupo_id: 'gUSD', nome: 'Chase', tipo: 'Corrente', saldo: 1000, moeda: 'USD' },
        { id: 'u-nu', grupo_id: 'gUSD', nome: 'Nubank', tipo: 'Corrente', saldo: 5000, moeda: 'BRL' },
        { id: 'u-wise', grupo_id: 'gUSD', nome: 'Wise', tipo: 'Corrente', saldo: 4090.34, moeda: 'NOK' },
      ],
      transacoes: [{ id: 't1', grupo_id: 'gUSD', tipo: 'Gasto', valor: 50, carteira_nome: 'Chase', moeda: null, valor_moeda: null, taxa_brl: null }],
      recorrencias: [
        { id: 'rb', grupo_id: 'gBRL', valor: 10000, valor_moeda: 20000, moeda: 'NOK' },
        { id: 'ru', grupo_id: 'gUSD', valor: 1, valor_moeda: 20000, moeda: 'NOK' },
      ],
    });
    const carregarB = carregar(b);

    const { moverCarteira } = carregarB('handlers/pendentes.js');
    const mv = await moverCarteira('t1', 'Nubank', 'gUSD');
    const t1 = b.tabelas.transacoes.find((t) => t.id === 't1');
    eq([t1.valor, t1.moeda, t1.valor_moeda], [cent(50 / TAXAS.USD), 'BRL', 50], 'mover US$ 50 pra conta em real: o número vira R$ 50 (reinterpreta) e o valor na base é US$ 9,72');
    ok(mv.conversao && /US\$/.test(mv.conversao.texto), `o "≈" do zap fala a BASE (dólar), não real — veio ${mv && mv.conversao && mv.conversao.texto}`);

    const { atualizarRecorrenciasEstrangeiras } = carregarB('services/moeda.js');
    await atualizarRecorrenciasEstrangeiras();
    const rb = b.tabelas.recorrencias.find((r) => r.id === 'rb');
    const ru = b.tabelas.recorrencias.find((r) => r.id === 'ru');
    eq([rb.valor, rb.taxa_brl], [cent(20000 * TAXAS.NOK), TAXAS.NOK], 'cron: conta fixa em coroa num grupo em REAL, igual a antes');
    eq([ru.valor, ru.taxa_brl], [cent(20000 * TAXAS.NOK / TAXAS.USD), TAXAS.NOK / TAXAS.USD], '⚠️ cron: a mesma conta num grupo em DÓLAR vai pra dólar');

    const { moedaDaCarteira } = carregarB('services/recorrencias.js');
    eq(await moedaDaCarteira('gUSD', 'Wise', 'USD'), 'NOK', 'conta fixa lê a moeda da conta');
    eq(await moedaDaCarteira('gUSD', 'Não Existe', 'USD'), 'USD', '⚠️ conta que não existe está na BASE');
    eq(await moedaDaCarteira('gBRL', 'Não Existe'), 'BRL', 'sem base informada, como antes: real');

    const { carteiraQueDebita } = carregarB('services/quitacao.js');
    const ws = [{ nome: 'Chase', moeda: 'USD' }, { nome: 'Nubank', moeda: 'BRL' }, { nome: 'Velha' }];
    eq([!!carteiraQueDebita(ws, 'Chase', 'USD'), !!carteiraQueDebita(ws, 'Nubank', 'USD'), !!carteiraQueDebita(ws, 'Velha', 'USD')], [true, false, true], '"Paguei" num grupo em dólar: debita a conta em dólar, pula a em real');
    eq([!!carteiraQueDebita(ws, 'Chase'), !!carteiraQueDebita(ws, 'Nubank'), !!carteiraQueDebita(ws, 'Velha')], [false, true, true], '"Paguei" num grupo em real: como antes');

    // O "Paguei" de ponta a ponta: a base tem de chegar até o débito.
    const { quitarOcorrencia } = carregarB('services/quitacao.js');
    const hoje = carregarB('services/cicloFatura.js').hojeSP();
    const saldoDe = (id) => cent(b.tabelas.wallets.find((x) => x.id === id).saldo);
    const antesChase = saldoDe('u-chase'); const antesNu = saldoDe('u-nu');
    const base = { grupoId: 'gUSD', userId: 'u1', competencia: hoje.slice(0, 7), data: hoje, valor: 30 };
    const q1 = await quitarOcorrencia({ ...base, rec: { id: 'r-luz', tipo: 'Gasto', valor: 30, categoria: 'Casa', descricao: 'Luz', carteira: 'Chase' }, carteira_nome: 'Chase' });
    const q2 = await quitarOcorrencia({ ...base, rec: { id: 'r-gas', tipo: 'Gasto', valor: 30, categoria: 'Casa', descricao: 'Gás', carteira: 'Nubank' }, carteira_nome: 'Nubank' });
    eq([q1.status, q2.status], [200, 200], 'as duas baixas respondem 200');
    eq(cent(antesChase - saldoDe('u-chase')), 30, '⚠️ "Paguei" num grupo em dólar DEBITA a conta em dólar');
    eq(saldoDe('u-nu'), antesNu, '⚠️ e NÃO debita US$ 30 de uma conta em real');

    const { motivoRecusa } = carregarB('services/rateio.js');
    const TX = { valor: 100, parcela_total: null, transferencia: false };
    ok(!motivoRecusa({ ...TX, moeda: null }), 'rateio aceita lançamento na base');
    ok(!!motivoRecusa({ ...TX, moeda: 'BRL', valor_moeda: 514.35 }), '⚠️ rateio recusa lançamento de conta em real num grupo em dólar');

    const { aPagarCartoes } = carregarB('services/aPagarCartoes.js');
    const cartoes = [{ id: 'c1', nome: 'Amex', tipo: 'Crédito', moeda: 'USD' }, { id: 'c2', nome: 'Nubank', tipo: 'Crédito', moeda: 'BRL' }];
    const vista = async (g, c) => (c.id === 'c1' ? 100 : 514.35);
    const emDolar = await aPagarCartoes('gUSD', cartoes, TAXAS, { base: 'USD', vistaDoCartao: vista });
    eq([emDolar.total, emDolar.semCambio], [200, 0], 'a pagar num grupo em dólar: US$ 100 + R$ 514,35 = US$ 200');
    const emReal = await aPagarCartoes('gBRL', cartoes, TAXAS, { vistaDoCartao: vista });
    eq(emReal.total, cent(100 * TAXAS.USD + 514.35), 'sem base: soma em real, como antes');
  }
  console.log('  ok');

  // ── 7. Investimentos: cotação em real vira a moeda do grupo ────────────────
  console.log('── 7. investimentos: preço de mercado na moeda base ──');
  {
    const M = carregar(criarBanco({}))('services/moeda.js');
    eq(M.fatorCotacaoParaBase('BRL', 'BRL', {}), 1, 'grupo em real: fator 1');
    eq(M.fatorCotacaoParaBase('USD', 'BRL', TAXAS), TAXAS.USD, '⚠️ grupo em real com ação em dólar: CONVERTE (o defeito do MELI, corrigido)');
    eq(M.fatorCotacaoParaBase('USD', 'BRL', {}), null, 'sem câmbio do dólar: null, nunca o preço em dólar como real');
    eq(M.fatorCotacaoParaBase('BRL', 'USD', TAXAS), 1 / TAXAS.USD, 'grupo em dólar com ação da B3: real → dólar');
    eq(M.fatorCotacaoParaBase('USD', 'USD', TAXAS), 1, 'grupo em dólar com ação em dólar: nada a converter');
    eq(M.fatorCotacaoParaBase('GBp', 'BRL', { ...TAXAS, GBP: 7 }), null, '⚠️ pence de Londres (GBp) NÃO vira libra (GBP) — seria 100× maior');
    eq(M.fatorCotacaoParaBase('XYZ', 'BRL', TAXAS), null, 'sigla desconhecida não converte nem vira real');
    eq(M.fatorCotacaoParaBase('GBP', 'BRL', { ...TAXAS, GBP: 7 }), 7, 'libra de verdade converte');
    eq(M.fatorCotacaoParaBase('NOK', 'USD', TAXAS), TAXAS.NOK / TAXAS.USD, 'cotação em coroa num grupo em dólar: taxa cruzada');
    eq(M.fatorCotacaoParaBase('BRL', 'NOK', { USD: 5 }), null, '⚠️ sem cotação da base: null (quem chama não grava)');

    const mercado = {
      'ITSA4.SA': { precoAtual: 10, variacaoDia: 1, moeda: 'BRL', dividendos: 0.5 },
      'AAPL':     { precoAtual: 200, variacaoDia: 2, moeda: 'USD', dividendos: 0 },
      'bitcoin':  { precoAtual: 500000, variacaoDia: 3, moeda: 'BRL' },
    };
    const cenario = () => ({
      grupos: [{ id: 'gBRL', moeda_base: 'BRL' }, { id: 'gUSD', moeda_base: 'USD' }],
      users: [{ id: 'uB', grupo_ativo: 'gBRL' }, { id: 'uU', grupo_ativo: 'gUSD' }],
      investimentos: [
        { id: 'b1', grupo_id: 'gBRL', tipo: 'Ações', ticker: 'ITSA4.SA', quantidade: 100, valor_aportado: 900 },
        { id: 'b2', grupo_id: 'gBRL', tipo: 'Ações', ticker: 'AAPL', quantidade: 2, valor_aportado: 300 },
        { id: 'u1', grupo_id: 'gUSD', tipo: 'Ações', ticker: 'ITSA4.SA', quantidade: 100, valor_aportado: 180 },
        { id: 'u2', grupo_id: 'gUSD', tipo: 'Ações', ticker: 'AAPL', quantidade: 2, valor_aportado: 300 },
        { id: 'u3', grupo_id: 'gUSD', tipo: 'Cripto', ticker: 'bitcoin', quantidade: 0.01, valor_aportado: 900 },
      ],
    });
    const b = criarBanco(cenario());
    const R = carregar(b, [], mercado)('routes/investimentos.js');
    const atualizar = rota(R, 'post', '/atualizar-precos/:phone');
    const sleep = global.setTimeout;
    global.setTimeout = (fn) => sleep(fn, 0);   // sem os 600 ms de rate limit no eval
    try {
      await chamar(atualizar, { authUser: { id: 'uB' }, params: { phone: 'x' } });
      await chamar(atualizar, { authUser: { id: 'uU' }, params: { phone: 'x' } });
    } finally { global.setTimeout = sleep; }
    const inv = (id) => b.tabelas.investimentos.find((i) => i.id === id);
    eq([inv('b1').valor_atual, inv('b1').dividendos_acumulados], [1000, 50], 'grupo em real, B3: igual a antes (10 × 100, dividendos 0,50 × 100)');
    eq(inv('b2').valor_atual, 400 * TAXAS.USD, '⚠️ grupo em real, Nasdaq: US$ 400 viram R$ 2.057,40 (antes gravava 400 como real)');
    eq([cent(inv('u1').valor_atual), cent(inv('u1').dividendos_acumulados)], [cent(1000 / TAXAS.USD), cent(50 / TAXAS.USD)], '⚠️ grupo em dólar, B3: R$ 1.000 vira US$ 194,42 (e os dividendos também)');
    eq(inv('u2').valor_atual, 400, 'grupo em dólar, Nasdaq: US$ 400 direto');
    eq(cent(inv('u3').valor_atual), cent(5000 / TAXAS.USD), 'grupo em dólar, bitcoin cotado em real: convertido');

    const cotacao = rota(R, 'get', '/cotacao');
    const cB = await chamar(cotacao, { authUser: { id: 'uB', grupoAtivo: 'gBRL' }, query: { ticker: 'AAPL', tipo: 'acao' } });
    eq([cB.body.precoBRL, cB.body.precoBase, cB.body.moedaBase, cB.body.taxaBase], [200 * TAXAS.USD, 200 * TAXAS.USD, 'BRL', TAXAS.USD], 'cotação no grupo em real: precoBase = precoBRL (campos antigos intactos)');
    const cU = await chamar(cotacao, { authUser: { id: 'uU', grupoAtivo: 'gUSD' }, query: { ticker: 'AAPL', tipo: 'acao' } });
    eq([cU.body.precoBase, cU.body.moedaBase], [200, 'USD'], 'cotação de ação em dólar num grupo em dólar: o próprio preço');
    const cU2 = await chamar(cotacao, { authUser: { id: 'uU', grupoAtivo: 'gUSD' }, query: { ticker: 'ITSA4.SA', tipo: 'acao' } });
    eq([cent(cU2.body.precoBase), cU2.body.precoBRL], [cent(10 / TAXAS.USD), 10], 'cotação da B3 num grupo em dólar: convertida');
  }
  console.log('  ok');

  // ── 8. Open Finance: conta em real dentro de grupo em dólar ────────────────
  console.log('── 8. Open Finance num grupo fora do real: contas e cartões, lançamentos convertidos ──');
  {
    const chamadas = {};
    const cf8 = carregar(criarBanco({}))('services/cicloFatura.js');
    const hoje8 = cf8.hojeSP();
    // Cartão do Nubank: uma fatura já publicada (dá o fechamento 05 e o
    // vencimento 15), uma compra de R$ 514,35 hoje e o pagamento de R$ 300.
    const cartaoRaw = {
      id: 'card-1', brand_name: 'Nubank',
      identification: { name: 'Ultravioleta', payment_methods: [{ identification_number: '5555444433331234' }] },
      limits: [{ credit_line_limit_type: 'LIMITE_CREDITO_TOTAL', consolidation_type: 'CONSOLIDADO',
        limit_amount: { amount: '5000.00' }, used_amount: { amount: '514.35' }, available_amount: { amount: '4485.65' } }],
    };
    const faturasCartao = [{ id: 'bill-ago', due_date: '2026-08-15', bill_closing_date: '2026-08-05',
      bill_total_amount: { amount: '300.00' }, payments: [] }];
    // Empréstimo, investimento (com uma movimentação) e caixinha — tudo em real.
    const emprestimoRaw = {
      id: 'loan-1', brand_name: 'Nubank', product_sub_type: 'EMPRESTIMO_PESSOAL_SEM_CONSIGNACAO',
      product_name: 'Crédito Pessoal', currency: 'BRL',
      contract_amount: { amount: '8000.00', currency: 'BRL' },
      next_instalment_amount: { amount: '629.51' },
      contract_date: '2026-02-10', first_instalment_due_date: '2026-03-10',
      scheduled_instalments: { total_number_of_instalments: 36, paid_instalments: 4, past_due_instalments: 0 },
      payments: { contract_outstanding_balance: { amount: '7000.00' } },
    };
    const investimentoRaw = {
      id: 'inv-1', __familia: 'bank_fixed_income', __path: 'bank-fixed-incomes',
      investment_type: 'CDB', brand_name: 'Nubank', product_name: 'CDB Nubank',
      balance: {
        net_amount: { amount: '10287.00', currency: 'BRL' },
        quantity: { amount: '1' },
        updated_unit_price: { amount: '10287.00' },
        purchase_unit_price: { amount: '10000.00' },
      },
    };
    const movimentoRaw = {
      id: 'mov-1', transaction_date: '2026-09-01', type: 'ENTRADA', transaction_type: 'APLICACAO',
      transaction_net_value: { amount: '1000.00' }, transaction_gross_value: { amount: '1000.00' },
      transaction_quantity: { amount: '1' }, transaction_unit_price: { amount: '1000.00' },
    };
    const caixinhaRaw = { reserved_identification: 'cx-1', reserved_name: 'Viagem',
      available_amount: [{ amount: '5143.50', currency: 'BRL' }] };
    const txsCartao = [
      { id: 'of-c1', transaction_name: 'AMAZON MARKETPLACE', credit_debit_type: 'DEBITO',
        completed_authorised_payment_type: 'TRANSACAO_EFETIVADA', brazilian_amount: { amount: '514.35' },
        transaction_date_time: `${hoje8}T12:00:00Z` },
      { id: 'of-c2', transaction_name: 'Pagamento recebido', credit_debit_type: 'CREDITO',
        completed_authorised_payment_type: 'TRANSACAO_EFETIVADA', brazilian_amount: { amount: '300.00' },
        transaction_date_time: `${hoje8}T11:00:00Z` },
    ];
    const conta = (id) => ({
      id, brand_name: 'Nubank', type: 'CONTA_DEPOSITO_A_VISTA',
      identification: { type: 'CONTA_DEPOSITO_A_VISTA', subtype: 'INDIVIDUAL', currency: 'BRL' },
      balance: { available_amount: { amount: '5143.50', currency: 'BRL' }, has_reserved_balance: true },
    });
    const txsConta = [
      { id: 'of-t1', transaction_name: 'MERCADO SAO JOSE', credit_debit_type: 'DEBITO',
        completed_authorised_payment_type: 'TRANSACAO_EFETIVADA', transaction_amount: { amount: '514.35' },
        transaction_date_time: '2026-09-10T10:00:00Z' },
    ];
    const celcoin = () => {
      const conta1 = async (nome, v) => { chamadas[nome] = (chamadas[nome] || 0) + 1; return v; };
      return {
        getConsentimento: async () => ({ status: 'AUTHORISED' }),
        listarContas: () => conta1('contas', [conta('acc-1')]),
        listarTransacoesConta: () => conta1('txConta', txsConta),
        listarSaldosReservados: () => conta1('caixinhas', [caixinhaRaw]),
        listarCartoes: () => conta1('cartoes', [cartaoRaw]),
        listarFaturas: async () => faturasCartao,
        listarTransacoesCartao: async () => txsCartao,
        listarParcelamentos: async () => [],
        listarEmprestimos: () => conta1('emprestimos', [emprestimoRaw]),
        listarFinanciamentos: () => conta1('financiamentos', []),
        listarInvestimentos: () => conta1('investimentos', [investimentoRaw]),
        listarTransacoesInvestimento: () => conta1('movInvestimento', [movimentoRaw]),
      };
    };
    const cenario = (grupo, base) => ({
      grupos: [{ id: grupo, moeda_base: base }],
      of_conexoes: [{ id: 'con-1', provider: 'polp-celcoin', external_id: 'cons-1', grupo_id: grupo, user_id: 'u1', instituicao: 'Nubank' }],
      // Conta do próprio usuário, NA MOEDA DO GRUPO — é ela que denuncia quem
      // soma carteira sem olhar a moeda (converteria dólar como se fosse real).
      wallets: [{ id: 'w-propria', grupo_id: grupo, nome: 'Carteira', tipo: 'Corrente', saldo: 2000, moeda: base }],
    });

    // Grupo em DÓLAR.
    const bU = criarBanco(cenario('gUSD', 'USD'));
    const syncU = carregar(bU, [], {}, celcoin())('services/polpCelcoinSync.js');
    const rU = await syncU.sincronizarConsentimento('cons-1');
    const wU = bU.tabelas.wallets.filter((w) => w.grupo_id === 'gUSD' && w.tipo !== 'Crédito' && w.of_conta_id);
    const tU = bU.tabelas.transacoes.filter((t) => t.grupo_id === 'gUSD' && t.carteira_nome === (wU[0] && wU[0].nome));
    eq([wU.length, wU[0] && wU[0].moeda], [1, 'BRL'], 'a conta do banco entra como conta EM REAL dentro do grupo em dólar');
    eq(tU.map((t) => [t.valor, t.moeda, t.valor_moeda, t.taxa_brl]), [[100, 'BRL', 514.35, 1 / TAXAS.USD]],
      '⚠️ o lançamento de R$ 514,35 entra como US$ 100, com o original em real ao lado');
    eq([chamadas.cartoes, chamadas.emprestimos, chamadas.financiamentos, chamadas.investimentos, chamadas.caixinhas],
      [1, 1, 1, 1, 1], 'num grupo em dólar o sync busca TUDO — cartão, empréstimo, financiamento, investimento e caixinha');

    // Tudo o que o banco manda em real vira dólar pela cotação do dia.
    const emBase = (v) => cent(v / TAXAS.USD);
    const dividaU = bU.tabelas.dividas.find((d) => d.of_id === 'loan-1');
    eq([dividaU.valor_total, dividaU.valor_parcela, dividaU.saldo_devedor, dividaU.parcelas_total],
      [emBase(8000), emBase(629.51), emBase(7000), 36],
      '⚠️ empréstimo de R$ 8.000 entra como US$ 1.555,36 (parcela e saldo devedor junto); nº de parcelas intacto');
    const invU = bU.tabelas.investimentos.find((i) => i.of_id === 'inv-1');
    eq([invU.valor_atual, invU.valor_aportado, invU.preco_unitario, invU.quantidade, invU.moeda, cent(invU.rentabilidade * 10000)],
      // preço unitário arredonda em 8 casas (cota de R$ 0,0101 na base), não em centavo
      [emBase(10287), emBase(10000), Math.round((10287 / TAXAS.USD) * 1e8) / 1e8, 1, 'USD', 287],
      '⚠️ CDB de R$ 10.287 entra como US$ 2.000, a moeda vira a do grupo e a rentabilidade (razão) não muda');
    const movU = (bU.tabelas.investimento_movimentos || []).find((m) => m.of_mov_id === 'mov-1');
    eq([movU.valor, movU.valor_bruto], [emBase(1000), emBase(1000)], 'a movimentação do investimento também entra convertida');
    const cxU = bU.tabelas.of_caixinhas.find((c) => c.external_id === 'cx-1');
    eq([cxU.saldo, cxU.moeda], [emBase(5143.5), 'USD'], '⚠️ caixinha de R$ 5.143,50 entra como US$ 1.000');
    const fotoU = bU.tabelas.patrimonio_historico[0];
    eq([fotoU.investido, fotoU.patrimonio_total], [emBase(10287), cent(emBase(10287) + emBase(5143.5) + 2000)],
      '⚠️ a foto do patrimônio soma a conta do banco CONVERTIDA (e a conta em dólar pelo valor dela)');

    // O CARTÃO (C3): entra em real, lançamentos convertidos, fatura em real.
    const cU = bU.tabelas.wallets.filter((w) => w.grupo_id === 'gUSD' && w.tipo === 'Crédito');
    eq([cU.length, cU[0] && cU[0].moeda, cU[0] && cU[0].dia_fechamento, cU[0] && cU[0].dia_vencimento], [1, 'BRL', 5, 15],
      'o cartão do banco entra como cartão EM REAL, com as datas do emissor');
    const txCartao = (b, id) => b.tabelas.transacoes.find((t) => t.of_tx_id === id);
    const c1 = txCartao(bU, 'of-c1');
    const c2 = txCartao(bU, 'of-c2');
    eq([c1.valor, c1.moeda, c1.valor_moeda, c1.taxa_brl], [100, 'BRL', 514.35, 1 / TAXAS.USD],
      '⚠️ compra de R$ 514,35 no cartão entra como US$ 100 no gasto do mês, original em real ao lado');
    eq([c2.valor, c2.valor_moeda, c2.transferencia], [cent(300 / TAXAS.USD), 300, true], 'o pagamento da fatura também guarda o original');
    eq((bU.tabelas.pagamentos_fatura || []).filter((p) => p.cartao_id === cU[0].id).map((p) => p.valor), [300],
      '⚠️ pagamento vindo do banco abate R$ 300 da fatura (a moeda dela), não US$ 58,33');
    const compDeHoje = (w) => {
      const atual = cf8.competenciaAtual(w);
      for (const d of [-1, 0, 1, 2]) {
        const c = d === 0 ? atual : cf8.competenciaVizinha(w, atual, d);
        const ci = cf8.cicloPorCompetencia(w, c);
        if (ci.ini <= hoje8 && hoje8 < ci.fimExcl) return c;
      }
      return atual;
    };
    const Lu = carregar(bU);
    const stU = await Lu('services/faturaRollover.js').statusFatura('gUSD', cU[0], compDeHoje(cU[0]));
    eq(stU.fatura, 514.35, '⚠️ a fatura do cartão importado soma R$ 514,35 — o número do app do banco');
    ok((rU.avisos || []).some((a) => /grupo em USD/.test(a)), `o relatório do sync diz o que ficou de fora — veio ${JSON.stringify(rU.avisos)}`);

    // A cobrança do banco ASSUME a previsão da conta fixa (reconciliarPrevisto):
    // o valor original e a taxa têm de passar a ser os do banco.
    bU.tabelas.transacoes.push({ id: 'prev-1', grupo_id: 'gUSD', tipo: 'Gasto', valor: 100, data: '2026-09-11',
      carteira_nome: wU[0].nome, recorrente: true, pago: false, of_tx_id: null,
      moeda: 'BRL', valor_moeda: 480, taxa_brl: 0.2 });
    txsConta.push({ id: 'of-t2', transaction_name: 'LUZ', credit_debit_type: 'DEBITO',
      completed_authorised_payment_type: 'TRANSACAO_EFETIVADA', transaction_amount: { amount: '514.35' },
      transaction_date_time: '2026-09-12T10:00:00Z' });
    await syncU.sincronizarConsentimento('cons-1');
    const prev = bU.tabelas.transacoes.find((t) => t.id === 'prev-1');
    eq([prev.of_tx_id, prev.valor, prev.moeda, prev.valor_moeda, prev.taxa_brl, prev.pago], ['of-t2', 100, 'BRL', 514.35, 1 / TAXAS.USD, true],
      '⚠️ previsão assumida pelo banco: original R$ 514,35 e a taxa do dia (não os R$ 480 previstos)');

    // Grupo em REAL: tudo como antes.
    for (const k of Object.keys(chamadas)) delete chamadas[k];
    txsConta.length = 1;
    const bB = criarBanco(cenario('gBRL', 'BRL'));
    const syncB = carregar(bB, [], {}, celcoin())('services/polpCelcoinSync.js');
    await syncB.sincronizarConsentimento('cons-1');
    const contaB = bB.tabelas.wallets.find((w) => w.grupo_id === 'gBRL' && w.tipo !== 'Crédito' && w.of_conta_id);
    const tB = bB.tabelas.transacoes.filter((t) => t.grupo_id === 'gBRL' && t.carteira_nome === contaB.nome);
    eq(tB.map((t) => [t.valor, 'moeda' in t, 'valor_moeda' in t]), [[514.35, false, false]], 'grupo em real: a linha sai SEM colunas de moeda, como antes');
    const c1B = bB.tabelas.transacoes.find((t) => t.of_tx_id === 'of-c1');
    eq([c1B.valor, 'moeda' in c1B, 'valor_moeda' in c1B], [514.35, false, false], 'grupo em real: a compra no cartão sai SEM colunas de moeda, como antes');
    const cB = bB.tabelas.wallets.find((w) => w.grupo_id === 'gBRL' && w.tipo === 'Crédito');
    eq((bB.tabelas.pagamentos_fatura || []).filter((p) => p.cartao_id === cB.id).map((p) => p.valor), [300], 'grupo em real: pagamento do banco como antes');
    const dividaB = bB.tabelas.dividas.find((d) => d.of_id === 'loan-1');
    eq([dividaB.valor_total, dividaB.valor_parcela, dividaB.saldo_devedor], [8000, 629.51, 7000], 'grupo em real: o empréstimo entra com os valores do banco, como antes');
    const invB = bB.tabelas.investimentos.find((i) => i.of_id === 'inv-1');
    eq([invB.valor_atual, invB.valor_aportado, invB.preco_unitario, invB.moeda], [10287, 10000, 10287, 'BRL'], 'grupo em real: o investimento entra como antes');
    const movB = (bB.tabelas.investimento_movimentos || []).find((m) => m.of_mov_id === 'mov-1');
    eq(movB.valor, 1000, 'grupo em real: a movimentação entra como antes');
    const cxB = bB.tabelas.of_caixinhas.find((c) => c.external_id === 'cx-1');
    eq([cxB.saldo, cxB.moeda], [5143.5, 'BRL'], 'grupo em real: a caixinha entra como antes');
    const fotoB = bB.tabelas.patrimonio_historico[0];
    eq([fotoB.investido, fotoB.patrimonio_total], [10287, cent(10287 + 5143.5 + 2000)], 'grupo em real: a foto do patrimônio é a soma de sempre');
    eq([chamadas.cartoes, chamadas.emprestimos, chamadas.financiamentos, chamadas.investimentos, chamadas.caixinhas],
      [1, 1, 1, 1, 1], 'grupo em real: cartões, empréstimos, investimentos e caixinhas seguem sendo buscados');
  }
  console.log('  ok');

  // ── 9. Cartão numa moeda diferente da base ─────────────────────────────────
  //
  // O caso real é o cartão do Open Finance (só fala real) num grupo em dólar.
  // A fatura, o limite e os pagamentos estão NA MOEDA DO CARTÃO; o que soma
  // cartão com o resto converte pra base. E pagar/antecipar pela Sora fica
  // travado nesse caso — mas NUNCA num grupo em real.
  console.log('── 9. cartão fora da moeda base: fatura na moeda dele, total na do grupo ──');
  {
    const cf = carregar(criarBanco({}))('services/cicloFatura.js');
    const CICLO = { dia_fechamento: 5, dia_vencimento: 15 };
    const compAtual = cf.competenciaAtual(CICLO);
    const ciclo = cf.cicloPorCompetencia(CICLO, compAtual);
    const noCiclo = `${ciclo.ini}T12:00:00.000Z`;
    const noFuturo = `${cf.competenciaVizinha(CICLO, compAtual, 3)}-10T12:00:00.000Z`;

    const cenario = () => ({
      grupos: [{ id: 'gBRL', moeda_base: 'BRL' }, { id: 'gUSD', moeda_base: 'USD' }],
      wallets: [
        { id: 'b-itau', grupo_id: 'gBRL', nome: 'Itaú', tipo: 'Corrente', saldo: 3000, moeda: 'BRL' },
        { id: 'b-nu', grupo_id: 'gBRL', nome: 'Nubank Crédito', tipo: 'Crédito', saldo: 0, limite: 5000, moeda: 'BRL', of_conta_id: 'of-b', ...CICLO },
        { id: 'u-chase', grupo_id: 'gUSD', nome: 'Chase', tipo: 'Corrente', saldo: 1000, moeda: 'USD' },
        { id: 'u-nu', grupo_id: 'gUSD', nome: 'Nubank Crédito', tipo: 'Crédito', saldo: 0, limite: 5000, moeda: 'BRL', of_conta_id: 'of-u', ...CICLO },
        { id: 'u-amex', grupo_id: 'gUSD', nome: 'Amex', tipo: 'Crédito', saldo: 0, limite: 2000, moeda: 'USD', ...CICLO },
      ],
      transacoes: [
        { id: 'tb', grupo_id: 'gBRL', tipo: 'Gasto', categoria: 'Mercado', valor: 514.35, carteira_nome: 'Nubank Crédito', data: noCiclo, pago: true },
        { id: 'tu', grupo_id: 'gUSD', tipo: 'Gasto', categoria: 'Mercado', valor: 100, moeda: 'BRL', valor_moeda: 514.35, taxa_brl: 1 / TAXAS.USD, carteira_nome: 'Nubank Crédito', data: noCiclo, pago: true },
        { id: 'ta', grupo_id: 'gUSD', tipo: 'Gasto', categoria: 'Mercado', valor: 40, carteira_nome: 'Amex', data: noCiclo, pago: true },
      ],
    });
    const parcelasFuturas = [
      { id: 'pu', grupo_id: 'gUSD', tipo: 'Gasto', categoria: 'Eletrônicos', valor: 19.44, moeda: 'BRL', valor_moeda: 100, taxa_brl: 1 / TAXAS.USD,
        carteira_nome: 'Nubank Crédito', observacao: 'Fone', data: noFuturo, pago: false, parcela_num: 3, parcela_total: 3 },
      { id: 'pb', grupo_id: 'gBRL', tipo: 'Gasto', categoria: 'Eletrônicos', valor: 100,
        carteira_nome: 'Nubank Crédito', observacao: 'Fone', data: noFuturo, pago: false, parcela_num: 3, parcela_total: 3 },
    ];

    // 9a. Painel: a fatura, o payload e as travas.
    {
      const b = criarBanco(cenario());
      const chamadas = [];
      const L = carregar(b, chamadas);
      const w = (id) => b.tabelas.wallets.find((x) => x.id === id);
      const saldo = (id) => cent(w(id).saldo);

      const { statusFatura } = L('services/faturaRollover.js');
      eq((await statusFatura('gUSD', w('u-nu'), compAtual)).fatura, 514.35,
        '⚠️ a fatura do cartão em real num grupo em dólar soma o ORIGINAL (R$ 514,35), não os US$ 100');
      eq((await statusFatura('gBRL', w('b-nu'), compAtual)).fatura, 514.35, 'grupo em real: a mesma fatura de sempre');
      eq((await statusFatura('gUSD', w('u-amex'), compAtual)).fatura, 40, 'cartão em dólar num grupo em dólar: US$ 40');

      const W = L('routes/wallets.js');
      const faturas = rota(W, 'get', '/faturas/:phone');
      const fB = (await chamar(faturas, { grupoId: 'gBRL' })).body.faturas.find((f) => f.cartao_id === 'b-nu');
      eq([fB.fatura, fB.restante, fB.moeda, fB.moeda_base, fB.taxa_base, fB.bloqueio_pagamento],
        [514.35, 514.35, 'BRL', 'BRL', 1, null], 'grupo em real: /faturas igual, com moeda do grupo, taxa 1 e sem bloqueio');
      eq(chamadas.length, 0, 'grupo em real: /faturas não busca câmbio');

      const listaU = (await chamar(faturas, { grupoId: 'gUSD' })).body.faturas;
      const fU = listaU.find((f) => f.cartao_id === 'u-nu');
      const fA = listaU.find((f) => f.cartao_id === 'u-amex');
      eq([fU.fatura, fU.restante, fU.limite, fU.moeda, fU.moeda_base, fU.taxa_base],
        [514.35, 514.35, 5000, 'BRL', 'USD', 1 / TAXAS.USD], '⚠️ grupo em dólar: a fatura do cartão em real vem EM REAL, com a taxa pra dólar ao lado');
      ok(/real/.test(fU.bloqueio_pagamento || '') && /dólar/.test(fU.bloqueio_pagamento || '') && /banco/.test(fU.bloqueio_pagamento || ''),
        `o bloqueio explica as duas moedas e que o pagamento vem do banco — veio ${fU.bloqueio_pagamento}`);
      eq([fA.fatura, fA.moeda, fA.taxa_base, fA.bloqueio_pagamento], [40, 'USD', 1, null], 'cartão em dólar num grupo em dólar: taxa 1, sem bloqueio');

      const status = rota(W, 'get', '/fatura/status/:phone');
      const sU = (await chamar(status, { authUser: { id: 'u1', grupoAtivo: 'gUSD' }, query: { cartao_id: 'u-nu' } })).body;
      eq([sU.restante, sU.moeda, sU.moeda_base, sU.taxa_base, !!sU.bloqueio_pagamento], [514.35, 'BRL', 'USD', 1 / TAXAS.USD, true],
        '/fatura/status traz a mesma moeda e o mesmo bloqueio de /faturas');
      const sB = (await chamar(status, { authUser: { id: 'u1', grupoAtivo: 'gBRL' }, query: { cartao_id: 'b-nu' } })).body;
      eq([sB.restante, sB.moeda, sB.taxa_base, sB.bloqueio_pagamento], [514.35, 'BRL', 1, null], '/fatura/status em grupo em real: sem bloqueio');

      const pagar = rota(W, 'post', '/fatura/pagar');
      const nTx = b.tabelas.transacoes.length;
      const pU = await chamar(pagar, { grupoId: 'gUSD', body: { cartao_id: 'u-nu', wallet_id: 'u-chase', valor: 100 } });
      eq([pU.statusCode, pU.body.codigo, saldo('u-chase'), b.tabelas.transacoes.length, (b.tabelas.pagamentos_fatura || []).length],
        [409, 'cartao_outra_moeda', 1000, nTx, 0], '⚠️ pagar pelo painel o cartão em real num grupo em dólar é RECUSADO antes de debitar qualquer conta');
      const pA = await chamar(pagar, { grupoId: 'gUSD', body: { cartao_id: 'u-amex', wallet_id: 'u-chase', valor: 40 } });
      eq([pA.statusCode, saldo('u-chase')], [200, 960], 'cartão em dólar num grupo em dólar: paga normal');
      const pB = await chamar(pagar, { grupoId: 'gBRL', body: { cartao_id: 'b-nu', wallet_id: 'b-itau', valor: 514.35 } });
      eq([pB.statusCode, saldo('b-itau')], [200, cent(3000 - 514.35)], 'grupo em real: o cartão do Open Finance segue aceitando pagamento pelo painel');

      b.tabelas.transacoes.push(...JSON.parse(JSON.stringify(parcelasFuturas)));
      const R = L('routes/transacoes.js');
      const antecipar = rota(R, 'post', '/antecipar-cartao');
      const tx = (id) => b.tabelas.transacoes.find((t) => t.id === id);
      const aU = await chamar(antecipar, { grupoId: 'gUSD', body: { ids: ['pu'], conta_nome: 'Chase' } });
      eq([aU.statusCode, aU.body.codigo, tx('pu').pago, saldo('u-chase')], [409, 'cartao_outra_moeda', false, 960],
        '⚠️ antecipar parcela do cartão em real num grupo em dólar é recusado ANTES de marcar a parcela');
      const aB = await chamar(antecipar, { grupoId: 'gBRL', body: { ids: ['pb'], conta_nome: 'Itaú' } });
      eq([aB.statusCode, aB.body.debitado, tx('pb').pago], [200, 100, true], 'grupo em real: antecipa como antes');

      const parcelado = rota(R, 'post', '/parcelado');
      const sofa = (g) => b.tabelas.transacoes.filter((t) => t.grupo_id === g && t.observacao === 'Sofá');
      await chamar(parcelado, { grupoId: 'gUSD', userId: 'u1', body: { categoria: 'Casa', observacao: 'Sofá', carteira_nome: 'Nubank Crédito', valor_parcela: 100, num_parcelas: 2 } });
      eq(sofa('gUSD').map((t) => [t.valor, t.moeda, t.valor_moeda]), [[cent(100 / TAXAS.USD), 'BRL', 100], [cent(100 / TAXAS.USD), 'BRL', 100]],
        '⚠️ parcelado pelo painel no cartão em real: R$ 100 por parcela, US$ 19,44 na base');
      await chamar(parcelado, { grupoId: 'gBRL', userId: 'u1', body: { categoria: 'Casa', observacao: 'Sofá', carteira_nome: 'Nubank Crédito', valor_parcela: 100, num_parcelas: 2 } });
      eq(sofa('gBRL').map((t) => [t.valor, 'moeda' in t, 'valor_moeda' in t]), [[100, false, false], [100, false, false]],
        'parcelado em grupo em real: a linha sai SEM colunas de moeda, como antes');

      // Editar a compra do cartão importado: a fatura (que soma o original) acompanha.
      // (Compara a DIFERENÇA: o 1º "Sofá" parcelado acima pode cair neste ciclo, conforme o dia.)
      const faturaAntes = (await statusFatura('gUSD', w('u-nu'), compAtual)).fatura;
      await chamar(rota(R, 'put', '/:id'), { grupoId: 'gUSD', params: { id: 'tu' }, body: { valor: 110 } });
      const novoOriginal = Math.round((110 / (1 / TAXAS.USD)) * 100) / 100;
      eq(cent((await statusFatura('gUSD', w('u-nu'), compAtual)).fatura - faturaAntes), cent(novoOriginal - 514.35),
        '⚠️ editar US$ 100 → US$ 110 na compra do cartão em real sobe a fatura R$ 51,44 — ela não fica parada');
    }

    // 9b. WhatsApp: pagar, antecipar, parcelar e "gastos por cartão".
    {
      const b = criarBanco(cenario());
      b.tabelas.transacoes.push(...JSON.parse(JSON.stringify(parcelasFuturas)));
      const L = carregar(b);
      const msgs = [];
      const mensageiro = require(path.resolve(__dirname, '../src/services/mensageiro.js'));
      mensageiro.enviarTexto = async (p, t) => { msgs.push(t); };
      mensageiro.enviarBotaoLink = async (p, o) => { msgs.push(o.message); };
      const parcelas = L('handlers/parcelas.js');
      const ctx = (grupoId) => ({ phone: '5511999999999', grupoId, user: { id: 'u1' } });
      const pendentes = () => (b.tabelas.transacoes_pendentes || []).length;
      const tx = (id) => b.tabelas.transacoes.find((t) => t.id === id);

      msgs.length = 0;
      await parcelas({ acao: 'pagar_fatura', termo: 'nubank' }, ctx('gUSD'));
      ok(msgs.length === 1 && /real/.test(msgs[0]) && /dólar/.test(msgs[0]), `zap: "pagar fatura nubank" num grupo em dólar explica a recusa — veio ${JSON.stringify(msgs)}`);
      eq(pendentes(), 0, '⚠️ e NÃO abre a pergunta de qual conta debitar');
      msgs.length = 0;
      await parcelas({ acao: 'pagar_fatura', termo: 'nubank' }, ctx('gBRL'));
      ok(msgs.some((m) => /Com qual conta/.test(m)) && pendentes() === 1, `zap, grupo em real: segue perguntando de qual conta — veio ${JSON.stringify(msgs)}`);
      msgs.length = 0;
      await parcelas({ acao: 'pagar_fatura', termo: 'amex' }, ctx('gUSD'));
      ok(msgs.some((m) => /Com qual conta/.test(m)), `zap: cartão em dólar num grupo em dólar segue perguntando de qual conta — veio ${JSON.stringify(msgs)}`);

      b.tabelas.transacoes_pendentes = [];
      msgs.length = 0;
      await parcelas({ acao: 'antecipar_parcela', termo: 'Fone' }, ctx('gUSD'));
      ok(msgs.length === 1 && /real/.test(msgs[0]) && /dólar/.test(msgs[0]), `zap: antecipar a parcela do cartão em real num grupo em dólar explica a recusa — veio ${JSON.stringify(msgs)}`);
      eq([pendentes(), tx('pu').pago], [0, false], '⚠️ e não pergunta conta nem mexe na parcela');
      msgs.length = 0;
      await parcelas({ acao: 'antecipar_parcela', termo: 'Fone' }, ctx('gBRL'));
      ok(msgs.some((m) => /De qual conta pago/.test(m)) && pendentes() === 1, `zap, grupo em real: antecipar segue perguntando a conta — veio ${JSON.stringify(msgs)}`);

      const compra = { acao: 'compra_parcelada', descricao: 'Tênis', numParcelas: 3, valorParcela: 100, valorTotal: 300, categoria: 'Roupas', carteira: 'Nubank Crédito' };
      const tenis = (g) => b.tabelas.transacoes.filter((t) => t.grupo_id === g && t.observacao === 'Tênis');
      await parcelas(compra, ctx('gUSD'));
      eq(tenis('gUSD').map((t) => [t.valor, t.moeda, t.valor_moeda]), [1, 2, 3].map(() => [cent(100 / TAXAS.USD), 'BRL', 100]),
        '⚠️ zap: "comprei tênis 300 em 3x no nubank" no cartão em real guarda R$ 100 por parcela e US$ 19,44 na base');
      await parcelas(compra, ctx('gBRL'));
      eq(tenis('gBRL').map((t) => [t.valor, 'moeda' in t, 'valor_moeda' in t]), [1, 2, 3].map(() => [100, false, false]),
        'zap, grupo em real: a parcela sai SEM colunas de moeda, como antes');

      // "parcelas": cada compra na moeda do CARTÃO; o total soma na do GRUPO.
      // A 1ª parcela do tênis cai hoje (já cobrada); sobram 2.
      msgs.length = 0;
      await parcelas({ acao: 'listar_parcelas' }, ctx('gUSD'));
      const totalUSD = (2 * cent(100 / TAXAS.USD)).toFixed(2).replace('.', ',');
      ok((msgs[0] || '').includes('Tênis* — Nubank Crédito\n   2x de R$ 100,00 a pagar')
        && (msgs[0] || '').includes(`Total ainda a pagar: US$ ${totalUSD}*`),
        `⚠️ zap "parcelas" num grupo em dólar: R$ 100 por parcela (moeda do cartão) e o total EM DÓLAR — veio ${msgs[0]}`);
      msgs.length = 0;
      await parcelas({ acao: 'listar_parcelas' }, ctx('gBRL'));
      ok((msgs[0] || '').includes('2x de R$ 100,00 a pagar') && (msgs[0] || '').includes('Total ainda a pagar: R$ 200,00*'),
        `zap "parcelas" num grupo em real: igual a antes — veio ${msgs[0]}`);
    }

    // 9c. O que SOMA cartão com o resto: gastos por carteira, Oráculo, Agenda.
    {
      const b = criarBanco(cenario());
      const L = carregar(b);
      const msgs = [];
      const mensageiro = require(path.resolve(__dirname, '../src/services/mensageiro.js'));
      mensageiro.enviarTexto = async (p, t) => { msgs.push(t); };
      mensageiro.enviarBotaoLink = async (p, o) => { msgs.push(o.message); };
      const carteiras = L('handlers/wallets.js');
      await carteiras({ acao: 'gastos_carteiras' }, { phone: '5511999999999', grupoId: 'gUSD', user: { id: 'u1' } });
      ok((msgs[0] || '').includes('*Nubank Crédito:* R$ 514,35') && (msgs[0] || '').includes('Total: US$ 140,00'),
        `⚠️ zap "gastos por cartão": a fatura do cartão sai EM REAL e o TOTAL em dólar (US$ 100 + US$ 40) — veio ${msgs[0]}`);
      msgs.length = 0;
      await carteiras({ acao: 'gastos_carteiras' }, { phone: '5511999999999', grupoId: 'gBRL', user: { id: 'u1' } });
      ok((msgs[0] || '').includes('*Nubank Crédito:* R$ 514,35') && (msgs[0] || '').includes('Total: R$ 514,35'),
        `grupo em real: "gastos por cartão" tudo em real — veio ${msgs[0]}`);

      const { lerFoto } = L('handlers/oraculo.js');
      const fotoU = await lerFoto('gUSD');
      const oU = fotoU.cartoes.find((c) => c.id === 'u-nu');
      const oA = fotoU.cartoes.find((c) => c.id === 'u-amex');
      eq([oU.limite, oU.faturaAberta, oA.limite, oA.faturaAberta, fotoU.caixa],
        [Math.round(500000 * (1 / TAXAS.USD)), Math.round(51435 * (1 / TAXAS.USD)), 200000, 4000, 100000],
        '⚠️ Oráculo num grupo em dólar: limite e fatura do cartão em real convertidos pra dólar (centavos)');
      const fotoB = await lerFoto('gBRL');
      const oB = fotoB.cartoes.find((c) => c.id === 'b-nu');
      eq([oB.limite, oB.faturaAberta, fotoB.caixa], [500000, 51435, 300000], 'Oráculo em grupo em real: igual a antes');

      const { montarFeed } = L('services/agendaFeed.js');
      const faturasDaAgenda = async (g) => (await montarFeed(g, ciclo.venc, ciclo.venc))
        .filter((e) => e.source === 'fatura').map((e) => [e.id, e.valor]).sort();
      eq(await faturasDaAgenda('gUSD'), [[`fat-u-amex-${ciclo.venc}`, 40], [`fat-u-nu-${ciclo.venc}`, 100]],
        '⚠️ Agenda num grupo em dólar: a fatura de R$ 514,35 aparece como US$ 100');
      eq(await faturasDaAgenda('gBRL'), [[`fat-b-nu-${ciclo.venc}`, 514.35]], 'Agenda em grupo em real: igual a antes');
    }

    // 9d. As regras puras.
    {
      const M = carregar(criarBanco({}))('services/moeda.js');
      eq([M.cartaoForaDaBase({ moeda: 'BRL' }, 'USD'), M.cartaoForaDaBase({ moeda: 'USD' }, 'USD'), M.cartaoForaDaBase({ moeda: 'USD' }, 'BRL'),
        M.cartaoForaDaBase({ nome: 'sem moeda no select' }, 'USD'), M.cartaoForaDaBase(null, 'USD')],
      [true, false, false, false, false], '⚠️ só trava cartão fora da base; grupo em REAL nunca trava; sem a coluna `moeda` não trava às cegas');
      ok(!/banco/.test(M.motivoCartaoForaDaBase({ nome: 'Amex', moeda: 'BRL' }, 'USD')), 'cartão manual: o texto não promete que o pagamento vem do banco');

      const { comDinheiroNaBase } = carregar(criarBanco({}))('services/polpCelcoinSync.js');
      const doBanco = { valor: 100, preco: 3, nome: 'CDB' };
      eq(comDinheiroNaBase(doBanco, ['valor'], 1, ['preco']) === doBanco, true,
        'taxa 1 (todo grupo em real) devolve o MESMO objeto — não copia nem reescreve');
      eq(comDinheiroNaBase(doBanco, ['valor'], 0.5, ['preco']), { valor: 50, preco: 1.5, nome: 'CDB' },
        'fora da base converte só os campos de dinheiro; o resto fica');
      eq(doBanco, { valor: 100, preco: 3, nome: 'CDB' }, 'e o objeto original não é alterado');

      const { agruparParcelas } = carregar(criarBanco({}))('services/consultaParcela.js');
      const futuro = '2099-01-10T12:00:00.000Z';
      const linha = (extra) => ({ parcela_grupo: 'P1', parcela_total: 2, parcela_num: 1, observacao: 'Fone', carteira_nome: 'Nubank', pago: false, data: futuro, ...extra });
      const [gFora] = [...agruparParcelas([linha({ valor: 19.44, valor_moeda: 100 }), linha({ parcela_num: 2, valor: 19.44, valor_moeda: 100 })], [], '2026-09-17').values()];
      eq([gFora.valorParcela, gFora.valorRestante, gFora.valorRestanteBase], [100, 200, 38.88], '⚠️ parcela de cartão fora da base: na moeda do cartão, e a soma do grupo à parte');
      const [gBase] = [...agruparParcelas([linha({ valor: 100 }), linha({ parcela_num: 2, valor: 100 })], [], '2026-09-17').values()];
      eq([gBase.valorParcela, gBase.valorRestante, gBase.valorRestanteBase], [100, 200, 200], 'cartão na base: os dois números são o de sempre');
    }

    // 9e. O pagamento que o BANCO traz e a duplicata comparam o ORIGINAL.
    {
      const hoje = cf.hojeSP();
      const b = criarBanco({
        ...cenario(),
        transacoes: [
          { id: 'pgU', grupo_id: 'gUSD', tipo: 'Recebimento', transferencia: true, categoria: 'Fatura', valor: 100, moeda: 'BRL',
            valor_moeda: 514.35, taxa_brl: 1 / TAXAS.USD, of_tx_id: 'of-pg-u', carteira_nome: 'Nubank Crédito', data: hoje },
          { id: 'pgB', grupo_id: 'gBRL', tipo: 'Recebimento', transferencia: true, categoria: 'Fatura', valor: 514.35,
            of_tx_id: 'of-pg-b', carteira_nome: 'Nubank Crédito', data: hoje },
        ],
      });
      const L = carregar(b);
      const { registrarPagamentosDoOF } = L('services/faturaRollover.js');
      const w = (id) => b.tabelas.wallets.find((x) => x.id === id);
      await registrarPagamentosDoOF('gUSD', w('u-nu'));
      await registrarPagamentosDoOF('gBRL', w('b-nu'));
      const pago = (id) => (b.tabelas.pagamentos_fatura || []).filter((p) => p.cartao_id === id).map((p) => p.valor);
      eq(pago('u-nu'), [514.35], '⚠️ pagamento da fatura trazido pelo banco num grupo em dólar abate R$ 514,35 (a moeda da fatura), não US$ 100');
      eq(pago('b-nu'), [514.35], 'grupo em real: o pagamento do banco abate como antes');

      // `carregar` troca duplicadas.js por um stub (as rotas só disparam o aviso);
      // aqui é a regra de verdade.
      const arqDuplicadas = path.resolve(__dirname, '../src/services/duplicadas.js');
      delete require.cache[arqDuplicadas];
      const { ehDuplicata } = require(arqDuplicadas);
      const manual = { id: 'm', tipo: 'Gasto', valor: 100, moeda: 'BRL', valor_moeda: 514.35, carteira_nome: 'Nubank Crédito', observacao: 'Mercado', data: '2026-09-10' };
      const doBanco = { ...manual, id: 'o', valor: 99.98, of_tx_id: 'of-x', data: '2026-09-11' };
      eq(ehDuplicata(manual, doBanco), 'manual-e-banco', '⚠️ a mesma compra de R$ 514,35 convertida por taxas de dias diferentes AINDA é duplicata');
      eq(ehDuplicata(manual, { ...doBanco, valor: 100, valor_moeda: 520 }), null, 'compras de valores originais diferentes não são duplicata, mesmo com o convertido igual');
    }

    // 9f. O aviso AUTOMÁTICO de fatura (cron) — a terceira porta pro pagamento.
    {
      const b = criarBanco(cenario());
      const L = carregar(b);
      const raizSrc = path.resolve(__dirname, '../src');
      const fixarModulo = (arq, exports) => { require.cache[arq] = { id: arq, filename: arq, loaded: true, exports }; };
      // O jobs registra crons ao ser exigido e manda aviso proativo por template.
      fixarModulo(require.resolve('node-cron'), { schedule: () => ({ stop() {} }) });
      const proativos = [];
      fixarModulo(path.join(raizSrc, 'services/proativo.js'), {
        provedor: () => 'zapi',
        enviarProativo: async (phone, o) => { proativos.push(o.texto); },
        enviarProativoDetalhado: async (phone, o) => { proativos.push(o.texto); return { ok: true }; },
      });
      const msgs = [];
      require(path.join(raizSrc, 'services/mensageiro.js')).enviarTexto = async (p, t) => { msgs.push(t); };
      const logOriginal = console.log;
      console.log = () => {};            // o jobs anuncia cada cron no require
      let avisarFatura;
      try { ({ avisarFatura } = L('jobs/index.js')); } finally { console.log = logOriginal; }

      const w = (id) => b.tabelas.wallets.find((x) => x.id === id);
      const pendentes = () => (b.tabelas.transacoes_pendentes || []).length;
      const dono = { id: 'u1', phone: '5511999990001' };
      await avisarFatura({ titulo: '💳 *Fatura do Nubank Crédito fechou*', ciclo, total: 514.35, dono, cartao: w('u-nu'), competencia: compAtual });
      eq([pendentes(), msgs.length, proativos.length], [0, 0, 1], '⚠️ aviso automático num grupo em dólar: só AVISA, sem abrir a pergunta de qual conta pagar');
      ok((proativos[0] || '').includes('Total: R$ 514,35') && !/Com qual conta/.test(proativos[0] || ''),
        `o aviso traz o valor da fatura em real e não pergunta a conta — veio ${proativos[0]}`);
      await avisarFatura({ titulo: '💳 *Fatura do Nubank Crédito fechou*', ciclo, total: 514.35, dono, cartao: w('b-nu'), competencia: compAtual });
      ok(pendentes() === 1 && msgs.some((m) => /Com qual conta você quer pagar/.test(m)),
        `grupo em real: o aviso segue oferecendo o pagamento — veio ${JSON.stringify(msgs)}`);
    }
  }
  console.log('  ok');

  // ══════════════════════════════════════════════════════════════════════════
  // 10. ENTRADA: o símbolo da moeda é RUÍDO, em qualquer moeda do catálogo
  // ══════════════════════════════════════════════════════════════════════════
  // A Fase 3 cuidou da SAÍDA. Esta seção é a entrada: quem escreve pelo
  // WhatsApp diz "gastei US$ 50" ou "gastei 50 coroas", e o número dito é
  // NATIVO da carteira onde a transação cai (`camposTransacao`) — o símbolo
  // nunca disse a moeda do lançamento.
  //
  // ⚠️ O modo de falha medido NÃO era "não entendeu": "gastei US$ 50 no
  // mercado" caía em BUSCAR e respondia "nenhum gasto encontrado para
  // mercado"; e "gastei 50 dólares no mercado" salvava com observação
  // "dólares", categoria "Outros" e carteira_nome "mercado" — conta que não
  // existe, a família do bug da conta-fantasma.
  //
  // ⚠️ ESTE É O ESPELHO de `MOEDAS` em services/moeda.js: o interpretador não
  // pode importar o catálogo (ele instancia o Supabase no import), então a
  // lista de símbolos está escrita à mão lá. Esta seção falha no dia em que
  // alguém acrescentar uma moeda e esquecer do interpretador.
  console.log('── 10. entrada: símbolo de moeda é ruído em qualquer moeda ──');
  {
    const { interpretarRapido } = require('../src/handlers/interpretador');
    const { MOEDAS } = require('../src/services/moeda');

    // A frase em real é a REFERÊNCIA: todas as outras têm de dar o mesmo.
    const alvo = interpretarRapido('gastei 50 no mercado');
    eq([alvo.acao, alvo.valor, alvo.categoria, alvo.observacao, alvo.carteira_nome],
      ['salvar', 50, 'Mercado', 'mercado', null],
      'referência: "gastei 50 no mercado" em real');

    const igual = (frase) => {
      const r = interpretarRapido(frase) || {};
      return r.acao === alvo.acao && r.valor === alvo.valor && r.categoria === alvo.categoria
        && r.observacao === alvo.observacao && r.carteira_nome === alvo.carteira_nome;
    };

    for (const [cod, m] of Object.entries(MOEDAS)) {
      ok(igual(`gastei ${m.simbolo} 50 no mercado`), `prefixo "${m.simbolo}" (${cod}) com espaço é ruído`);
      ok(igual(`gastei ${m.simbolo}50 no mercado`), `prefixo "${m.simbolo}" (${cod}) colado é ruído`);
    }

    // Milhar e decimal continuam em grafia BR (decisão de 17/09: a grafia segue
    // o IDIOMA, não a moeda) — o prefixo não pode estragar o `parseValor`.
    const mil = interpretarRapido('gastei US$ 1.250,00 no mercado') || {};
    eq([mil.acao, mil.valor], ['salvar', 1250], '⚠️ "US$ 1.250,00" vira 1250, não 1,25');

    // Palavra da moeda DEPOIS do número, incluindo sem acento (é como se digita).
    for (const p of ['dólares', 'dolares', 'coroas', 'kr', 'euros', 'libras', 'ienes', 'usd', 'nok']) {
      ok(igual(`gastei 50 ${p} no mercado`), `sufixo "${p}" não vira descrição nem carteira`);
    }

    // ⚠️ "peso(s)" e "franco(s)" ficaram FORA da lista de sufixo de propósito:
    // são palavras comuns em português, e "peso" ainda é campo do Grow. Aqui
    // NÃO vai asserção — escrevi uma ("gastei 50 no peso" segue com descrição
    // "peso") e a mutação provou que ela NÃO MORDE: o "no" entre o número e a
    // palavra já impede o casamento, então passaria igual com "peso" na lista.
    // Asserção que não morde dá confiança falsa; o motivo fica no comentário,
    // que é honesto sobre o que está e o que não está travado.

    // ⚠️ O LOOKAHEAD DE DÍGITO É O QUE PROTEGE A DESCRIÇÃO, e é o lado caro de
    // tirar "kr"/"chf" sempre: sem ele, "gastei 50 na kr modas" perderia o
    // "kr" da descrição. Medido em 24.366 observações da base, ZERO casam
    // /\b(kr|chf)\s*\d/ — mas as que têm "kr" NO MEIO do texto precisam sair
    // inteiras. (Primeiro escrevi aqui "quanto custa o $ hoje"; a mutação
    // mostrou que aquilo não mordia. Estas três mordem.)
    for (const f of ['gastei 50 na kr modas', 'gastei 50 no € shop', 'paguei 50 na loja kr']) {
      const r = interpretarRapido(f) || {};
      const esperado = f.replace(/^\w+ 50 (?:na|no) /, '');
      ok(r.observacao === esperado,
        `descrição com símbolo no meio sai inteira: "${f}" → esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(r.observacao)}`);
    }
  }
  console.log('  ok');

  console.log('');
  if (falhas.length) {
    console.log(`❌ ${falhas.length} falha(s):`);
    for (const f of falhas) console.log('   · ' + f);
    process.exit(1);
  }
  console.log('✅ moeda base: tudo passou');
})().catch((e) => { console.error(e); process.exit(1); });
