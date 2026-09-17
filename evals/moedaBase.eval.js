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
    let modo = 'select', payload = null, retornar = false, unica = null;
    const api = {
      select() { if (modo !== 'select') retornar = true; return api; },
      insert(p) { modo = 'insert'; payload = p; return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      upsert(p) { modo = 'upsert'; payload = p; return api; },
      delete() { modo = 'delete'; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      ilike(c, v) { filtros.push((r) => String(r[c] ?? '').toLowerCase() === String(v ?? '').toLowerCase()); return api; },
      is(c, v) { filtros.push((r) => (r[c] ?? null) === v); return api; },
      not(c, op, v) { filtros.push((r) => (op === 'is' ? (r[c] ?? null) !== v : true)); return api; },
      in(c, arr) { const s = new Set(arr); filtros.push((r) => s.has(r[c])); return api; },
      filter() { return api; }, gte() { return api; }, lte() { return api; },
      order() { return api; },
      limit() { return api; },
      single() { unica = 'single'; return api; },
      maybeSingle() { unica = 'maybe'; return api; },
      then(res, rej) { return Promise.resolve().then(executar).then(res, rej); },
    };
    function responder(linhas) {
      if (unica === 'single') return linhas.length === 1 ? { data: { ...linhas[0] }, error: null } : { data: null, error: { message: 'single' } };
      if (unica === 'maybe') return linhas.length > 1 ? { data: null, error: { message: 'multiple' } } : { data: linhas[0] ? { ...linhas[0] } : null, error: null };
      return { data: linhas.map((r) => ({ ...r })), error: null };
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
  console.log('── 8. Open Finance num grupo fora do real: só contas, lançamentos convertidos ──');
  {
    const chamadas = {};
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
        listarSaldosReservados: () => conta1('caixinhas', []),
        listarCartoes: () => conta1('cartoes', []),
        listarEmprestimos: () => conta1('emprestimos', []),
        listarFinanciamentos: () => conta1('financiamentos', []),
        listarInvestimentos: () => conta1('investimentos', []),
      };
    };
    const cenario = (grupo, base) => ({
      grupos: [{ id: grupo, moeda_base: base }],
      of_conexoes: [{ id: 'con-1', provider: 'polp-celcoin', external_id: 'cons-1', grupo_id: grupo, user_id: 'u1', instituicao: 'Nubank' }],
    });

    // Grupo em DÓLAR.
    const bU = criarBanco(cenario('gUSD', 'USD'));
    const syncU = carregar(bU, [], {}, celcoin())('services/polpCelcoinSync.js');
    const rU = await syncU.sincronizarConsentimento('cons-1');
    const wU = bU.tabelas.wallets.filter((w) => w.grupo_id === 'gUSD');
    const tU = bU.tabelas.transacoes.filter((t) => t.grupo_id === 'gUSD');
    eq([wU.length, wU[0] && wU[0].moeda], [1, 'BRL'], 'a conta do banco entra como conta EM REAL dentro do grupo em dólar');
    eq(tU.map((t) => [t.valor, t.moeda, t.valor_moeda, t.taxa_brl]), [[100, 'BRL', 514.35, 1 / TAXAS.USD]],
      '⚠️ o lançamento de R$ 514,35 entra como US$ 100, com o original em real ao lado');
    eq([chamadas.cartoes, chamadas.emprestimos, chamadas.financiamentos, chamadas.investimentos, chamadas.caixinhas],
      [undefined, undefined, undefined, undefined, undefined], '⚠️ cartões, empréstimos, investimentos e caixinhas NEM são buscados');
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
    const tB = bB.tabelas.transacoes.filter((t) => t.grupo_id === 'gBRL');
    eq(tB.map((t) => [t.valor, 'moeda' in t, 'valor_moeda' in t]), [[514.35, false, false]], 'grupo em real: a linha sai SEM colunas de moeda, como antes');
    eq([chamadas.cartoes, chamadas.emprestimos, chamadas.financiamentos, chamadas.investimentos, chamadas.caixinhas],
      [1, 1, 1, 1, 1], 'grupo em real: cartões, empréstimos, investimentos e caixinhas seguem sendo buscados');
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
