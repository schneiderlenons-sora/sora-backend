// =============================================================================
// EVAL — "Trazer movimentações a partir de [data]" (migration 202).
//
// O que não pode acontecer:
//   · gravar movimentação de dia anterior ao corte em QUALQUER sincronização;
//   · errar o dia perto da meia-noite (23h de 31/08 no Brasil é 01/09 em UTC);
//   · apagar lançamento que a pessoa DIGITOU, ou de OUTRO banco/conta;
//   · apagar antes de gravar o corte (um sync no meio traria tudo de volta);
//   · apagar alguma coisa quando o corte não pôde ser gravado (sem a 202).
//
// Rodar: npm run eval:importar-desde
// =============================================================================
const Module = require('module');
const path = require('path');
const fs = require('fs');
const RAIZ = path.resolve(__dirname, '..');
process.env.SUPABASE_URL = 'http://falso';
process.env.SUPABASE_KEY = 'falso';
process.env.CRONS_ATIVOS = '0';

const falhas = [];
let total = 0;
const ok = (c, m) => { total++; if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

const R = require(path.join(RAIZ, 'src/services/importarDesde.js'));

(async () => {
  console.log('── 1. o dia é o de São Paulo ──');
  eq(R.diaSP('2026-09-01'), '2026-09-01', 'data pura');
  eq(R.diaSP('2026-09-01T00:00:00+00:00'), '2026-09-01', 'data pura gravada como meia-noite UTC');
  eq(R.diaSP('2026-09-01T00:00:00.000Z'), '2026-09-01', 'meia-noite UTC com milissegundo');
  eq(R.diaSP('2026-09-01T02:59:59.000Z'), '2026-08-31', '⚠️ 23h59 de 31/08 no Brasil (02h59 UTC de 01/09)');
  eq(R.diaSP('2026-09-01T03:00:00.000Z'), '2026-09-01', 'meia-noite de 01/09 no Brasil');
  eq(R.diaSP('lixo'), '', 'data ilegível');
  eq(R.diaSP(null), '', 'sem data');

  console.log('── 2. validar a data que a tela manda ──');
  const H = { hoje: '2026-11-26' };
  eq(R.validarImportarDesde(null, H), { ok: true, desde: null }, 'null tira o corte');
  eq(R.validarImportarDesde('', H), { ok: true, desde: null }, 'vazio tira o corte');
  eq(R.validarImportarDesde('2026-09-01', H), { ok: true, desde: '2026-09-01' }, 'data válida');
  eq(R.validarImportarDesde('2026-11-26', H), { ok: true, desde: '2026-11-26' }, 'hoje vale');
  ok(!R.validarImportarDesde('2026-11-27', H).ok, 'amanhã não vale');
  ok(!R.validarImportarDesde('2026-02-30', H).ok, '30/02 não existe');
  ok(!R.validarImportarDesde('01/09/2026', H).ok, 'formato da tela brasileira não passa (a tela manda AAAA-MM-DD)');
  ok(!R.validarImportarDesde('2026-9-1', H).ok, 'sem zero à esquerda não passa');

  console.log('── 3. o corte ──');
  ok(R.dentroDoCorte('2025-01-01', null), 'sem corte, tudo entra');
  ok(!R.dentroDoCorte('2026-08-31', '2026-09-01'), 'dia anterior fica fora');
  ok(R.dentroDoCorte('2026-09-01', '2026-09-01'), 'o próprio dia entra');
  ok(R.dentroDoCorte('2026-09-01T00:00:00+00:00', '2026-09-01'), 'data pura do próprio dia entra');
  ok(!R.dentroDoCorte('2026-09-01T02:59:59.000Z', '2026-09-01'), '⚠️ 23h59 de 31/08 em SP fica fora');
  ok(R.dentroDoCorte('2026-09-01T03:00:00.000Z', '2026-09-01'), 'meia-noite de 01/09 em SP entra');
  ok(R.dentroDoCorte('lixo', '2026-09-01'), 'data ilegível entra (falha aberta: não some com lançamento)');
  eq(R.filtrarPorCorte([null, { data: '2026-08-30' }, { data: '2026-09-02' }, undefined], '2026-09-01').map((t) => t.data),
    ['2026-09-02'], 'filtra o lote e tira os vazios');
  eq(R.filtrarPorCorte([{ data: '2026-08-30' }], null).length, 1, 'sem corte o lote passa inteiro');
  eq(R.limiteDaConsulta('2026-09-01'), '2026-09-01T03:00:00.000Z', 'limite da consulta = meia-noite em SP');

  console.log('── 4. a sincronização respeita o corte (trava no código) ──');
  const sync = fs.readFileSync(path.join(RAIZ, 'src/services/polpCelcoinSync.js'), 'utf8');
  const chamadas = sync.match(/await inserirTransacoes\([^)]*\)[^;]*;/g) || [];
  ok(chamadas.length >= 2, 'há as duas gravações (conta e cartão)');
  ok(chamadas.every((c) => /\{ desde: desdeCorte \}/.test(c)), '⚠️ TODA chamada de inserirTransacoes leva o corte da conexão');
  ok(/const validas = filtrarPorCorte\(txs, desde\);/.test(sync), 'inserirTransacoes filtra pelo corte antes de qualquer coisa');
  ok(/const desdeCorte = conexao\.importar_desde \|\| null;/.test(sync), 'o corte vem da própria conexão');

  console.log('── 5. as rotas ──');
  const G = 'g1';
  const base = () => ({
    of_conexoes: [
      { id: 'c1', external_id: 'cons1', grupo_id: G, provider: 'polp-celcoin', importar_desde: null },
      { id: 'c2', external_id: 'cons-velho', grupo_id: G, provider: 'polp', importar_desde: null },
      { id: 'c3', external_id: 'cons-outro', grupo_id: 'g2', provider: 'polp-celcoin', importar_desde: null },
    ],
    wallets: [
      { nome: 'Itaú', grupo_id: G, of_consent_id: 'cons1' },
      { nome: 'Itaú Crédito', grupo_id: G, of_consent_id: 'cons1' },
      { nome: 'Nubank', grupo_id: G, of_consent_id: 'cons-nu' },
    ],
    transacoes: [
      { id: 't1', grupo_id: G, carteira_nome: 'Itaú', of_tx_id: 'a', data: '2026-08-31T00:00:00+00:00' }, // sai
      { id: 't2', grupo_id: G, carteira_nome: 'Itaú Crédito', of_tx_id: 'b', data: '2026-09-01T02:59:59.000Z' }, // sai (31/08 em SP)
      { id: 't3', grupo_id: G, carteira_nome: 'Itaú', of_tx_id: 'c', data: '2026-09-01T00:00:00+00:00' }, // fica (dia do corte)
      { id: 't4', grupo_id: G, carteira_nome: 'Itaú', of_tx_id: null, data: '2026-08-29T00:00:00+00:00' }, // fica (digitada)
      { id: 't5', grupo_id: G, carteira_nome: 'Nubank', of_tx_id: 'd', data: '2026-08-15T00:00:00+00:00' }, // fica (outro banco)
      { id: 't6', grupo_id: 'g2', carteira_nome: 'Itaú', of_tx_id: 'e', data: '2026-08-15T00:00:00+00:00' }, // fica (outro grupo)
      { id: 't7', grupo_id: G, carteira_nome: 'Itaú', of_tx_id: 'f', data: '2026-09-15T12:00:00.000Z' }, // fica (depois)
    ],
  });

  function bancoFalso(tabelas, cfg = {}) {
    const log = [];
    const casa = (row, fs2) => fs2.every(([op, c, v]) => {
      if (op === 'eq') return row[c] === v;
      if (op === 'in') return v.includes(row[c]);
      if (op === 'notnull') return row[c] !== null && row[c] !== undefined;
      if (op === 'lt') return new Date(row[c]).getTime() < new Date(v).getTime();
      return true;
    });
    const from = (nome) => {
      const filtros = [];
      let modo = 'select', patch = null, ini = 0, fim = Infinity;
      const linhas = () => (tabelas[nome] || []).filter((r) => casa(r, filtros));
      const exec = () => {
        if (modo === 'update') {
          if (cfg.semColuna && 'importar_desde' in patch) return { error: { message: 'column "importar_desde" does not exist' } };
          linhas().forEach((r) => Object.assign(r, patch));
          log.push(`update:${nome}`);
          return { error: null };
        }
        if (modo === 'delete') {
          const alvo = new Set(linhas());
          tabelas[nome] = tabelas[nome].filter((r) => !alvo.has(r));
          log.push(`delete:${nome}:${[...alvo].map((r) => r.id).join(',')}`);
          return { error: null };
        }
        return { data: linhas().slice(ini, fim + 1), error: null };
      };
      const q = {
        select() { return q; }, order() { return q; },
        eq(c, v) { filtros.push(['eq', c, v]); return q; },
        in(c, v) { filtros.push(['in', c, v]); return q; },
        not(c, op, v) { if (op === 'is' && v === null) filtros.push(['notnull', c]); return q; },
        lt(c, v) { filtros.push(['lt', c, v]); return q; },
        range(a, b) { ini = a; fim = b; return q; },
        update(p) { modo = 'update'; patch = p; return q; },
        delete() { modo = 'delete'; return q; },
        maybeSingle() { return Promise.resolve({ data: linhas()[0] || null, error: null }); },
        then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
      };
      return q;
    };
    return { db: { from }, log };
  }

  async function chamar(metodo, caminho, { params, query = {}, body = {}, tabelas = base(), cfg } = {}) {
    const { db, log } = bancoFalso(tabelas, cfg);
    const origLoad = Module._load;
    Module._load = function (req, parent, isMain) {
      if (req.endsWith('db/supabase')) return db;
      if (req.endsWith('middlewares/auth')) return (rq, rs, nx) => nx();
      if (req.endsWith('middlewares/permissao')) return { exigirPermissao: () => (rq, rs, nx) => { rq.grupoId = G; return nx(); } };
      if (req.endsWith('services/vencimentoDivida')) return { hojeSP: () => '2026-11-26' };
      return origLoad.call(this, req, parent, isMain);
    };
    for (const k of Object.keys(require.cache)) {
      if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
    }
    let router;
    try { router = require(path.join(RAIZ, 'src/routes/openFinance.js')); } finally { /* restaura abaixo */ }
    const camada = router.stack.find((c) => c.route?.path === caminho && c.route?.methods?.[metodo]);
    const pilha = camada.route.stack.map((s) => s.handle);
    let status = 200, json = null;
    const req = { params, query, body, grupoId: G };
    const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; }, sendStatus(s) { status = s; return res; } };
    let i = 0;
    const prox = async () => { const h = pilha[i++]; if (h) await h(req, res, prox); };
    try { await prox(); } finally { Module._load = origLoad; }
    return { status, json, log, tabelas };
  }

  const PUT = '/conexoes/:externalId/importar-desde';
  const GET = '/conexoes/:externalId/anteriores';

  let r = await chamar('get', GET, { params: { externalId: 'cons1' }, query: { desde: '2026-09-01' } });
  eq([r.status, r.json], [200, { quantidade: 2 }], 'prévia conta só as 2 do banco desta conexão antes do corte');

  r = await chamar('put', PUT, { params: { externalId: 'cons1' }, body: { desde: '2026-09-01', apagar_anteriores: true } });
  eq([r.status, r.json], [200, { ok: true, importar_desde: '2026-09-01', apagadas: 2 }], 'salva e apaga as 2');
  eq(r.tabelas.transacoes.map((t) => t.id).sort(), ['t3', 't4', 't5', 't6', 't7'], '⚠️ ficam: dia do corte, digitada, outro banco, outro grupo, depois do corte');
  eq(r.tabelas.of_conexoes[0].importar_desde, '2026-09-01', 'corte gravado na conexão');
  ok(r.log.indexOf('update:of_conexoes') < r.log.findIndex((l) => l.startsWith('delete:')), '⚠️ grava o corte ANTES de apagar');

  r = await chamar('put', PUT, { params: { externalId: 'cons1' }, body: { desde: '2026-09-01', apagar_anteriores: false } });
  eq([r.status, r.json.apagadas, r.tabelas.transacoes.length], [200, 0, 7], 'sem pedir pra apagar, só grava o corte');

  r = await chamar('put', PUT, { params: { externalId: 'cons1' }, body: { desde: null } });
  eq([r.status, r.json, r.tabelas.of_conexoes[0].importar_desde], [200, { ok: true, importar_desde: null, apagadas: 0 }, null], 'null tira o corte');

  r = await chamar('put', PUT, { params: { externalId: 'cons1' }, body: { desde: '2026-12-01', apagar_anteriores: true } });
  eq([r.status, r.tabelas.transacoes.length], [400, 7], 'data no futuro: 400 e nada apagado');

  r = await chamar('put', PUT, { params: { externalId: 'cons-outro' }, body: { desde: '2026-09-01', apagar_anteriores: true } });
  eq([r.status, r.tabelas.transacoes.length], [404, 7], 'conexão de outro grupo: 404 e nada apagado');

  r = await chamar('put', PUT, { params: { externalId: 'cons-velho' }, body: { desde: '2026-09-01', apagar_anteriores: true } });
  eq([r.status, r.tabelas.transacoes.length], [409, 7], 'trilho antigo: 409 e nada apagado');

  r = await chamar('put', PUT, { params: { externalId: 'cons1' }, body: { desde: '2026-09-01', apagar_anteriores: true }, cfg: { semColuna: true } });
  eq([r.status, r.tabelas.transacoes.length], [503, 7], '⚠️ sem a migration 202: 503 e NADA apagado');
  ok(!/column|migration/i.test(r.json.erro), 'mensagem sem jargão pro cliente');

  console.log(`\n${total} verificações · ${falhas.length ? `${falhas.length} FALHAS` : 'todas ok'}`);
  if (falhas.length) { falhas.forEach((f) => console.log('  ✘ ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
