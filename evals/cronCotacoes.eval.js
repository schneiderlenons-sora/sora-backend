// =============================================================================
// EVAL — o CRON das 03:00 que atualiza preços (JOB 3), rodado de verdade.
//
// ⚠️ POR QUE EXECUTAR O CRON E NÃO SÓ AS FUNÇÕES. A lição desta rodada inteira
// foi essa: a cotação passava em teste isolado e estava MORTA no caminho real.
// Conferindo o cron linha por linha depois de consertar a cotação, apareceram
// dois defeitos que NENHUM eval de função pegaria:
//
//   1. o cron mandava "bitcoin" pro `buscarCotacaoAcao`, que é BOLSA. As 8
//      posições de cripto da base só atualizavam quando alguém clicava no botão
//      do painel — a ROTA sempre teve o desvio pra cripto, o cron nunca teve.
//   2. `(porAcao || 0)` tratava "não consegui ler o dividendo" como "não pagou
//      dividendo", e o cron GRAVA. Com o Yahoo recusando o IP (o estado de
//      hoje), o cron apagaria o histórico de proventos de todo mundo.
//
// Supabase falso, provedores falsos, relógio irrelevante. O que se mede é o que
// o cron ESCREVEU.
//
// Rodar: node evals/cronCotacoes.eval.js
// =============================================================================
const Module = require('module');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-falso';

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const ok = (c, m) => { if (!c) falhas.push(m); };

/**
 * Roda o JOB 3 com um cenário e devolve tudo que ele FEZ.
 *
 * @param investimentos linhas de `investimentos`
 * @param acoes         ticker -> cotação (o que `buscarCotacaoAcao` devolve)
 * @param criptos       id     -> cotação (o que `buscarCotacaoCripto` devolve)
 * @param dividendo     número, ou `null` pra simular provedor fora do ar
 */
async function rodar({ investimentos, acoes = {}, criptos = {}, dividendo = 0 }) {
  const updates = [];
  const pedidosAcao = [];
  const pedidosCripto = [];

  const fake = (nome) => {
    const q = {
      _patch: null,
      select() { return q; }, eq(col, val) { if (q._patch) q._patchId = val; return q; },
      not() { return q; }, is() { return q; }, order() { return q; }, limit() { return q; },
      insert() { return q; },
      update(p) { q._patch = p; return q; },
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then(res) {
        if (q._patch) { updates.push({ t: nome, id: q._patchId, patch: q._patch }); return res({ data: null, error: null }); }
        if (nome === 'investimentos') return res({ data: investimentos, error: null });
        return res({ data: [], error: null });
      },
    };
    return q;
  };

  const jobs = [];
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) return { from: fake };
    if (req.endsWith('services/cotacoes')) {
      return {
        buscarCotacaoAcao: async (t) => { pedidosAcao.push(t); return acoes[t] || null; },
        buscarCotacaoCripto: async (t) => { pedidosCripto.push(t); return criptos[t] || null; },
        // ⚠️ `null` = "não consegui ler"; 0 = "não pagou". É a distinção toda.
        buscarDividendos: async () => dividendo,
        buscarTickers: async () => [],
        taxaParaBRL: async () => 1,
        taxaParaBRLDetalhe: async () => ({ taxa: 1, fonte: 'falso' }),
      };
    }
    if (req.endsWith('services/moeda')) {
      return {
        moedaBaseDoGrupo: async () => 'BRL',
        taxasParaBase: async () => ({}),
        // Ativo em BRL num grupo em BRL: fator 1, sem ida de rede.
        fatorCotacaoParaBase: (m, base) => (m === base ? 1 : null),
        formatadorDoGrupo: async () => (v) => String(v),
      };
    }
    if (req.endsWith('services/proativo')) {
      return { provedor: () => 'zapi', enviarProativo: async () => true, enviarProativoDetalhado: async () => ({ ok: true }) };
    }
    if (req.endsWith('services/mensageiro')) return new Proxy({}, { get: () => async () => true });
    // ⚠️ SÓ O JOB 3, filtrado pelo CORPO da função — depender da ordem de
    // registro quebraria ao inserir um cron novo.
    if (req === 'node-cron') {
      return {
        schedule: (_e, fn) => {
          if (/Atualizando investimentos/.test(String(fn))) jobs.push(fn);
          return { stop() {} };
        },
      };
    }
    return origLoad.call(this, req, parent, isMain);
  };

  try {
    for (const k of Object.keys(require.cache)) {
      if (/sora-backend[\\/]src[\\/]/.test(k)) delete require.cache[k];
    }
    require('../src/jobs/index.js');
    if (jobs.length !== 1) throw new Error(`esperava 1 JOB 3, achei ${jobs.length}`);
    // ⚠️ AWAIT AQUI DENTRO, NUNCA depois do `finally`. Com `rodou = jobs[0]()`
    // e o restore no `finally`, o job rodava ate o PRIMEIRO `await` e o resto
    // pegava os modulos REAIS — o Supabase falso funcionava (vem antes) e a
    // cotacao ia na rede de verdade. O sintoma foi o Yahoo sendo chamado no
    // meio de um eval que nao devia tocar em rede nenhuma.
    await jobs[0]();
  } finally {
    Module._load = origLoad;
  }
  return {
    updates: updates.filter((u) => u.t === 'investimentos'),
    pedidosAcao,
    pedidosCripto,
  };
}

(async () => {

const ACAO = { id: 'a1', grupo_id: 'g', ticker: 'PETR4.SA', tipo: 'Ações', quantidade: 10, valor_aportado: 300, dividendos_acumulados: 0 };
const CRIPTO = { id: 'c1', grupo_id: 'g', ticker: 'bitcoin', tipo: 'Cripto', quantidade: 0.5, valor_aportado: 100000, dividendos_acumulados: 0 };

console.log('-- 1. acao vai pro provedor de BOLSA --');
{
  const r = await rodar({
    investimentos: [ACAO],
    acoes: { 'PETR4.SA': { precoAtual: 54.33, moeda: 'BRL' } },
  });
  eq(r.pedidosAcao.length, 1, '1 pediu 1 cotacao de bolsa');
  eq(r.pedidosCripto.length, 0, '1 nao pediu cripto');
  eq(r.updates.length, 1, '1 gravou');
  eq(r.updates[0].patch.valor_atual, 543.3, '1 preco x quantidade');
}
console.log('  ok');

console.log('-- 2. CRIPTO vai pro provedor de CRIPTO (era o bug) --');
{
  // ⚠️ Antes, "bitcoin" ia pro `buscarCotacaoAcao`, que e bolsa: `ehTickerBR`
  // dizia nao, caia no Yahoo, que recusa o IP, e o cron desistia. As 8 posicoes
  // de cripto da base so atualizavam no clique do painel.
  const r = await rodar({
    investimentos: [CRIPTO],
    criptos: { bitcoin: { precoAtual: 418960, moeda: 'BRL' } },
  });
  eq(r.pedidosCripto.length, 1, '2 pediu cotacao de cripto');
  eq(r.pedidosCripto[0], 'bitcoin', '2 com o id em minuscula');
  eq(r.pedidosAcao.length, 0, '2 NAO mandou cripto pro provedor de bolsa');
  eq(r.updates.length, 1, '2 gravou');
  eq(r.updates[0].patch.valor_atual, 209480, '2 preco x quantidade');
}
console.log('  ok');

console.log('-- 3. os dois tipos na mesma rodada, cada um na sua fonte --');
{
  const r = await rodar({
    investimentos: [ACAO, CRIPTO],
    acoes: { 'PETR4.SA': { precoAtual: 54.33, moeda: 'BRL' } },
    criptos: { bitcoin: { precoAtual: 418960, moeda: 'BRL' } },
  });
  eq(r.pedidosAcao.join(','), 'PETR4.SA', '3 so a acao na bolsa');
  eq(r.pedidosCripto.join(','), 'bitcoin', '3 so a cripto na cripto');
  eq(r.updates.length, 2, '3 gravou as duas');
}
console.log('  ok');

console.log('-- 4. dividendo ILEGIVEL (null) MANTEM o historico --');
{
  // ⚠️ O estado de hoje: o Yahoo recusa o IP, o disjuntor fecha, e
  // `buscarDividendos` devolve null. Gravar 0 aqui APAGARIA o provento do
  // cliente, e o cron roda sozinho todo dia as 03:00.
  const comProvento = { ...ACAO, dividendos_acumulados: 120.5 };
  const r = await rodar({
    investimentos: [comProvento],
    acoes: { 'PETR4.SA': { precoAtual: 54.33, moeda: 'BRL' } },
    dividendo: null,
  });
  eq(r.updates[0].patch.dividendos_acumulados, 120.5, '4 manteve os R$ 120,50');
  // E a rentabilidade conta com o provento mantido, nao com zero.
  eq(r.updates[0].patch.rentabilidade, (543.3 + 120.5 - 300) / 300, '4 rentabilidade usa o provento mantido');
}
console.log('  ok');

console.log('-- 5. dividendo ZERO DE VERDADE sobrescreve --');
{
  // A regressao na outra direcao: congelar o provento pra sempre. Zero lido e
  // informacao ("este papel nao paga"), e tem de valer.
  const comProvento = { ...ACAO, dividendos_acumulados: 120.5 };
  const r = await rodar({
    investimentos: [comProvento],
    acoes: { 'PETR4.SA': { precoAtual: 54.33, moeda: 'BRL' } },
    dividendo: 0,
  });
  eq(r.updates[0].patch.dividendos_acumulados, 0, '5 zero lido sobrescreve');
}
console.log('  ok');

console.log('-- 6. dividendo NOVO entra multiplicado pela quantidade --');
{
  const r = await rodar({
    investimentos: [ACAO],
    acoes: { 'PETR4.SA': { precoAtual: 54.33, moeda: 'BRL' } },
    dividendo: 1.5,
  });
  eq(r.updates[0].patch.dividendos_acumulados, 15, '6 1,50 x 10 cotas');
}
console.log('  ok');

console.log('-- 7. CRIPTO nao consulta dividendo --');
{
  // Cripto nao paga provento; consultar e uma ida de rede jogada no lixo — e com
  // o provedor recusando, cada uma custa uma recusa.
  const comProvento = { ...CRIPTO, dividendos_acumulados: 7 };
  const r = await rodar({
    investimentos: [comProvento],
    criptos: { bitcoin: { precoAtual: 418960, moeda: 'BRL' } },
    dividendo: 99,
  });
  eq(r.updates[0].patch.dividendos_acumulados, 7, '7 nao mexeu no campo');
}
console.log('  ok');

console.log('-- 8. sem cotacao, NAO grava (nao zera o valor do cliente) --');
{
  const r = await rodar({ investimentos: [ACAO, CRIPTO] });   // nenhuma fonte responde
  eq(r.updates.length, 0, '8 nenhuma gravacao');
}
console.log('  ok');

console.log('-- 9. sem cambio pra moeda base, NAO grava --');
{
  // Ativo cotado em USD num grupo em BRL com o cambio fora: gravar o numero
  // cru seria registrar dolar como se fosse real.
  const r = await rodar({
    investimentos: [ACAO],
    acoes: { 'PETR4.SA': { precoAtual: 54.33, moeda: 'USD' } },
  });
  eq(r.updates.length, 0, '9 sem cambio nao grava');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  .', f));
  process.exit(1);
}
console.log('OK cronCotacoes: cripto na fonte certa, e provedor fora do ar nao apaga provento');
process.exit(0);
})();
