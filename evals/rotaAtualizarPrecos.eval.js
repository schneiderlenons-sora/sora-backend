// =============================================================================
// EVAL — a ROTA do botão "Atualizar cotações", executada de verdade.
//
// ⚠️ ESTE EVAL NASCEU DE UMA MUTAÇÃO SOBREVIVENTE. Eu tinha testado a regra do
// dividendo numa CÓPIA local dentro do eval ("null mantém, número sobrescreve")
// e a mutação provou o óbvio: trocar a linha da ROTA de volta pela versão que
// apaga o provento não quebrava nada. Testar a regra sem testar o call site é
// exatamente o furo que deixou a cotação morta em produção passando em tudo.
//
// Aqui o handler da rota roda de verdade — Supabase falso, provedores falsos,
// middlewares de auth/plano/permissão trocados por passagem livre — e o que se
// mede é o que a rota ESCREVEU.
//
// Rodar: node evals/rotaAtualizarPrecos.eval.js
// =============================================================================
const Module = require('module');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-falso';

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

/**
 * Roda o POST /atualizar-precos/:phone e devolve o que ele escreveu.
 *
 * @param investimentos linhas de `investimentos` do grupo
 * @param acoes         ticker -> cotação
 * @param criptos       id     -> cotação
 * @param dividendo     número, ou `null` pra simular provedor fora do ar
 */
async function rodar({ investimentos, acoes = {}, criptos = {}, dividendo = 0 }) {
  const updates = [];
  const pedidosAcao = [];
  const pedidosCripto = [];

  const fake = (nome) => {
    const q = {
      _patch: null, _id: null,
      select() { return q; },
      eq(col, val) { if (col === 'id') q._id = val; return q; },
      not() { return q; }, is() { return q; }, in() { return q; },
      order() { return q; }, limit() { return q; }, insert() { return q; },
      update(p) { q._patch = p; return q; },
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      // `getGrupoId` le `users.grupo_ativo` com `.single()` — sem isto a rota
      // responde 404 e nenhuma gravacao acontece (foi o 1o resultado do eval).
      single: () => Promise.resolve(nome === 'users'
        ? { data: { grupo_ativo: 'g' }, error: null }
        : { data: null, error: null }),
      then(res) {
        if (q._patch) { updates.push({ t: nome, id: q._id, patch: q._patch }); return res({ data: null, error: null }); }
        if (nome === 'investimentos') return res({ data: investimentos, error: null });
        return res({ data: [], error: null });
      },
    };
    return q;
  };

  const origLoad = Module._load;
  let router;
  try {
    for (const k of Object.keys(require.cache)) {
      if (/sora-backend[\\/]src[\\/]/.test(k)) delete require.cache[k];
    }
    Module._load = function (req, parent, isMain) {
      if (req.endsWith('db/supabase')) return { from: fake };
      if (req.endsWith('services/cotacoes')) {
        return {
          buscarCotacaoAcao: async (t) => { pedidosAcao.push(t); return acoes[t] || null; },
          buscarCotacaoCripto: async (t) => { pedidosCripto.push(t); return criptos[t] || null; },
          // ⚠️ `null` = "não consegui ler"; 0 = "não pagou". É a distinção toda.
          buscarDividendos: async () => dividendo,
          buscarTickers: async () => [],
          buscarCriptos: async () => [],
          listarCriptos: async () => [],
          taxaParaBRL: async () => 1,
          taxaParaBRLDetalhe: async () => ({ taxa: 1, fonte: 'falso' }),
        };
      }
      if (req.endsWith('services/moeda')) {
        return {
          moedaBaseDoGrupo: async () => 'BRL',
          taxasParaBase: async () => ({}),
          taxaEntre: async () => 1,
          fatorCotacaoParaBase: (m, base) => (m === base ? 1 : null),
          formatadorDoGrupo: async () => (v) => String(v),
        };
      }
      // ⚠️ Passagem livre nos middlewares: o que se testa aqui é a ARITMÉTICA da
      // rota. Auth e plano têm evals próprios, e mantê-los aqui só exigiria
      // montar um JWT falso sem medir nada novo.
      if (req.endsWith('middlewares/auth')) return (rq, rs, nx) => nx();
      if (req.endsWith('middlewares/plano')) return { exigirPlano: () => (rq, rs, nx) => nx() };
      if (req.endsWith('middlewares/permissao')) return { exigirPermissao: () => (rq, rs, nx) => nx() };
      return origLoad.call(this, req, parent, isMain);
    };
    router = require('../src/routes/investimentos.js');

    // Acha a camada do POST /atualizar-precos/:phone e chama o ÚLTIMO handler
    // (os anteriores são os middlewares que já foram trocados por passagem livre).
    const camada = router.stack.find((l) => l.route
      && l.route.path === '/atualizar-precos/:phone'
      && l.route.methods.post);
    if (!camada) throw new Error('nao achei a rota /atualizar-precos/:phone');
    const handler = camada.route.stack[camada.route.stack.length - 1].handle;

    const req = { params: { phone: '5511999999999' }, query: {}, body: {}, authUser: { id: 'u1', row: {} } };
    let corpo = null;
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(o) { corpo = o; return this; },
      sendStatus(c) { this.statusCode = c; return this; },
    };
    await handler(req, res, () => {});
    return { updates: updates.filter((u) => u.t === 'investimentos'), pedidosAcao, pedidosCripto, corpo, status: res.statusCode };
  } finally {
    Module._load = origLoad;
  }
}

(async () => {

const ACAO = { id: 'a1', grupo_id: 'g', ticker: 'PETR4.SA', tipo: 'Ações', quantidade: 10, valor_aportado: 300, dividendos_acumulados: 0 };
const CRIPTO = { id: 'c1', grupo_id: 'g', ticker: 'bitcoin', tipo: 'Cripto', quantidade: 0.5, valor_aportado: 100000, dividendos_acumulados: 0 };

console.log('-- 1. a rota grava o preco x quantidade --');
{
  const r = await rodar({ investimentos: [ACAO], acoes: { 'PETR4.SA': { precoAtual: 54.33, moeda: 'BRL' } } });
  eq(r.updates.length, 1, '1 gravou uma linha');
  eq(r.updates[0].id, 'a1', '1 na linha certa');
  eq(r.updates[0].patch.valor_atual, 543.3, '1 valor_atual');
  eq(r.updates[0].patch.rentabilidade, (543.3 - 300) / 300, '1 rentabilidade');
}
console.log('  ok');

console.log('-- 2. dividendo ILEGIVEL (null) MANTEM o historico --');
{
  // ⚠️ A MUTACAO QUE SOBREVIVIA. O estado de hoje e o provedor de dividendo
  // fora do ar; a rota GRAVA, entao 0 aqui apagaria o provento do cliente.
  const r = await rodar({
    investimentos: [{ ...ACAO, dividendos_acumulados: 120.5 }],
    acoes: { 'PETR4.SA': { precoAtual: 54.33, moeda: 'BRL' } },
    dividendo: null,
  });
  eq(r.updates[0].patch.dividendos_acumulados, 120.5, '2 manteve os R$ 120,50');
  eq(r.updates[0].patch.rentabilidade, (543.3 + 120.5 - 300) / 300, '2 rentabilidade usa o provento mantido');
}
console.log('  ok');

console.log('-- 3. dividendo ZERO DE VERDADE sobrescreve --');
{
  // A regressao na outra direcao: congelar o provento pra sempre.
  const r = await rodar({
    investimentos: [{ ...ACAO, dividendos_acumulados: 120.5 }],
    acoes: { 'PETR4.SA': { precoAtual: 54.33, moeda: 'BRL' } },
    dividendo: 0,
  });
  eq(r.updates[0].patch.dividendos_acumulados, 0, '3 zero lido sobrescreve');
}
console.log('  ok');

console.log('-- 4. dividendo NOVO entra x quantidade --');
{
  const r = await rodar({
    investimentos: [ACAO],
    acoes: { 'PETR4.SA': { precoAtual: 54.33, moeda: 'BRL' } },
    dividendo: 1.5,
  });
  eq(r.updates[0].patch.dividendos_acumulados, 15, '4 1,50 x 10 cotas');
}
console.log('  ok');

console.log('-- 5. cripto vai pro provedor de cripto e nao consulta dividendo --');
{
  const r = await rodar({
    investimentos: [{ ...CRIPTO, dividendos_acumulados: 7 }],
    criptos: { bitcoin: { precoAtual: 418960, moeda: 'BRL' } },
    dividendo: 99,
  });
  eq(r.pedidosCripto[0], 'bitcoin', '5 pediu na fonte de cripto');
  eq(r.pedidosAcao.length, 0, '5 nao pediu na bolsa');
  eq(r.updates[0].patch.valor_atual, 209480, '5 valor');
  eq(r.updates[0].patch.dividendos_acumulados, 7, '5 nao mexeu no provento');
}
console.log('  ok');

console.log('-- 6. sem cotacao e sem cambio, NAO grava --');
{
  const semFonte = await rodar({ investimentos: [ACAO, CRIPTO] });
  eq(semFonte.updates.length, 0, '6 sem cotacao nao grava');

  const semCambio = await rodar({
    investimentos: [ACAO],
    acoes: { 'PETR4.SA': { precoAtual: 54.33, moeda: 'USD' } },
  });
  eq(semCambio.updates.length, 0, '6 sem cambio nao grava dolar como real');
}
console.log('  ok');

console.log('-- 7. sem ticker, a rota nem tenta --');
{
  const r = await rodar({ investimentos: [{ id: 'f1', grupo_id: 'g', ticker: null, tipo: 'CDB', quantidade: 1, valor_aportado: 10500 }] });
  eq(r.updates.length, 0, '7 renda fixa sem ticker e pulada');
  eq(r.pedidosAcao.length, 0, '7 e nao gasta chamada');
}
console.log('  ok');

console.log('-- 8. um ativo sem cotacao NAO derruba os outros --');
{
  // ⚠️ A guarda que pula o ativo sem cotacao nao e redundante: sem ela o
  // `cotacao.moeda` estoura TypeError, o try/catch do handler devolve 500 e o
  // LACO PARA — quem vem depois na carteira nao atualiza. Uma cripto fora do
  // ar congelaria as acoes do mesmo cliente, e nada diria por que.
  const r = await rodar({
    investimentos: [CRIPTO, ACAO],   // a cripto vem ANTES e nao tem fonte
    acoes: { 'PETR4.SA': { precoAtual: 54.33, moeda: 'BRL' } },
  });
  eq(r.status, 200, '8 responde 200, nao 500');
  eq(r.updates.length, 1, '8 a acao foi atualizada mesmo assim');
  eq(r.updates[0].id, 'a1', '8 e foi a linha certa');
}
console.log('  ok');
console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  .', f));
  process.exit(1);
}
console.log('OK rotaAtualizarPrecos: a rota grava o certo e nao apaga provento que nao conseguiu ler');
process.exit(0);
})();
