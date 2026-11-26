// =============================================================================
// EVAL — Notas no painel (aba Notas do Drive). Tabela `notas` (063 + 203).
//
// O que não pode acontecer:
//   · ver, editar ou apagar a nota de OUTRA pessoa;
//   · cortar o texto em silêncio (quem "escreve muito" perderia o fim);
//   · "nenhuma nota" quando a leitura falhou;
//   · quebrar a aba enquanto a migration 203 não rodou (só fixar espera).
//
// Rodar: npm run eval:notas-painel
// =============================================================================
const Module = require('module');
const path = require('path');
const RAIZ = path.resolve(__dirname, '..');
process.env.SUPABASE_URL = 'http://falso';
process.env.SUPABASE_KEY = 'falso';
process.env.CRONS_ATIVOS = '0';

const falhas = [];
let total = 0;
const ok = (c, m) => { total++; if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

const N = require(path.join(RAIZ, 'src/services/notasPainel.js'));

(async () => {
  console.log('── 1. limpar o que a tela manda ──');
  eq(N.limparNota({ titulo: '  Ideias   de  viagem ', texto: 'linha 1\n\n  linha 2   ', categoria: ' Trabalho ' }),
    { ok: true, dados: { titulo: 'Ideias de viagem', texto: 'linha 1\n\n  linha 2', categoria: 'Trabalho' } },
    'título e caderno sem espaço sobrando; texto mantém as quebras e o recuo, só tira o fim');
  eq(N.limparNota({ texto: '    recuo da 1ª linha\nfim   ' }).dados.texto, '    recuo da 1ª linha\nfim',
    'o recuo da primeira linha fica (só o fim é limpo)');
  eq(N.limparNota({ texto: 'só texto' }).dados, { titulo: null, texto: 'só texto', categoria: null }, 'sem título e sem caderno vira null');
  ok(!N.limparNota({ titulo: '   ', texto: ' \n ' }).ok, 'nota vazia não é criada');
  ok(N.limparNota({ titulo: 'Só título' }).ok, 'só o título já é nota');
  const longo = 'a'.repeat(N.LIMITES.texto + 1);
  const r1 = N.limparNota({ texto: longo });
  ok(!r1.ok && /limite/.test(r1.erro), '⚠️ texto acima do limite: ERRO, nunca corte silencioso');
  ok(N.limparNota({ texto: 'a'.repeat(N.LIMITES.texto) }).ok, 'no limite exato passa');
  ok(!N.limparNota({ titulo: 'x'.repeat(201), texto: 'a' }).ok, 'título longo demais');
  ok(!N.limparNota({ texto: 'a', categoria: 'c'.repeat(41) }).ok, 'caderno longo demais');
  eq(N.limparNota({ texto: 'novo' }, { parcial: true }).dados, { texto: 'novo' }, 'edição só leva o campo enviado');
  eq(N.limparNota({ fixada: true }, { parcial: true }).dados, { fixada: true }, 'fixar sozinho');
  ok(!N.limparNota({ fixada: 'sim' }, { parcial: true }).ok, 'fixar só aceita booleano');
  ok(!N.limparNota({}, { parcial: true }).ok, 'edição sem nada');
  eq(N.limparNota({ categoria: '' }, { parcial: true }).dados, { categoria: null }, 'tirar do caderno');

  console.log('── 2. ordem ──');
  const ord = N.ordenarNotas([
    { id: 'a', created_at: '2026-11-01T10:00:00Z' },
    { id: 'b', fixada: true, created_at: '2026-10-01T10:00:00Z' },
    { id: 'c', created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-20T10:00:00Z' },
    { id: 'd', fixada: true, created_at: '2026-10-05T10:00:00Z' },
  ]).map((x) => x.id);
  eq(ord, ['d', 'b', 'c', 'a'], 'fixadas primeiro; depois a mexida mais recente (updated_at, senão created_at)');

  console.log('── 3. as rotas ──');
  function bancoFalso(tabelas, cfg = {}) {
    const log = [];
    const from = (nome) => {
      const filtros = [];
      let modo = 'select', patch = null, colunas = '*';
      const casa = (r) => filtros.every(([c, v]) => r[c] === v);
      const linhas = () => (tabelas[nome] || []).filter(casa);
      const sem203 = (txt) => cfg.sem203 && /fixada|updated_at/.test(txt);
      const exec = (unico) => {
        if (cfg.erroLeitura && modo === 'select' && nome === 'notas') return { data: null, error: { message: 'timeout' } };
        if (modo === 'select') {
          if (sem203(colunas)) return { data: null, error: { message: 'column notas.fixada does not exist' } };
          return { data: unico ? (linhas()[0] || null) : linhas(), error: null };
        }
        if (modo === 'insert') {
          const row = { id: `n${(tabelas[nome] || []).length + 1}`, created_at: '2026-11-26T12:00:00Z', ...patch };
          (tabelas[nome] = tabelas[nome] || []).push(row);
          log.push(['insert', row]);
          return { data: row, error: null };
        }
        if (modo === 'update') {
          if (sem203(Object.keys(patch).join(' '))) return { data: null, error: { message: 'column "fixada" of relation "notas" does not exist' } };
          const alvo = linhas();
          alvo.forEach((r) => Object.assign(r, patch));
          log.push(['update', patch]);
          return { data: unico ? (alvo[0] || null) : alvo, error: null };
        }
        if (modo === 'delete') {
          const alvo = linhas();
          tabelas[nome] = tabelas[nome].filter((r) => !alvo.includes(r));
          log.push(['delete', alvo.map((r) => r.id)]);
          return { data: alvo.map((r) => ({ id: r.id })), error: null };
        }
        return { data: null, error: null };
      };
      const q = {
        select(c) { if (modo === 'select') colunas = c || '*'; return q; },
        eq(c, v) { filtros.push([c, v]); return q; },
        order() { return q; }, limit() { return q; },
        insert(p) { modo = 'insert'; patch = p; return q; },
        update(p) { modo = 'update'; patch = p; return q; },
        delete() { modo = 'delete'; return q; },
        single() { return Promise.resolve(exec(true)); },
        maybeSingle() { return Promise.resolve(exec(true)); },
        then(res, rej) { return Promise.resolve(exec(false)).then(res, rej); },
      };
      return q;
    };
    return { db: { from }, log };
  }

  const EU = 'u1';
  const base = () => ({
    users: [{ id: EU, grupo_ativo: 'g1', plano: 'premium' }],
    notas: [
      { id: 'm1', user_id: EU, grupo_id: 'g1', titulo: 'Minha', texto: 'minha nota', categoria: null, origem: 'audio', created_at: '2026-11-20T10:00:00Z' },
      { id: 'o1', user_id: 'outra', grupo_id: 'g1', titulo: 'Da outra', texto: 'segredo', categoria: null, origem: 'texto', created_at: '2026-11-21T10:00:00Z' },
    ],
  });

  async function chamar(metodo, caminho, { params = {}, body = {}, tabelas = base(), cfg = {} } = {}) {
    const { db, log } = bancoFalso(tabelas, cfg);
    const origLoad = Module._load;
    Module._load = function (req, parent, isMain) {
      if (req.endsWith('db/supabase')) return db;
      if (req.endsWith('middlewares/auth')) return (rq, rs, nx) => nx();
      return origLoad.call(this, req, parent, isMain);
    };
    for (const k of Object.keys(require.cache)) {
      if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
    }
    const router = require(path.join(RAIZ, 'src/routes/dados.js'));
    const camada = router.stack.find((c) => c.route?.path === caminho && c.route?.methods?.[metodo]);
    const pilha = camada.route.stack.map((s) => s.handle);
    let status = 200, json = null;
    const req = { params, body, query: {}, authUser: { id: EU } };
    const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; } };
    let i = 0;
    const prox = async () => { const h = pilha[i++]; if (h) await h(req, res, prox); };
    try {
      await prox();
      // requireGrow chama next() sem esperar: aguarda a resposta da rota.
      for (let k = 0; k < 200 && json === null; k++) await new Promise((ok2) => setTimeout(ok2, 5));
    } finally { Module._load = origLoad; }
    return { status, json, log, tabelas };
  }

  // Listar
  let r = await chamar('get', '/notas/:phone', { params: { phone: 'x' } });
  eq([r.status, r.json.map((n) => n.id)], [200, ['m1']], '⚠️ lista SÓ as minhas notas (as do WhatsApp inclusive)');
  r = await chamar('get', '/notas/:phone', { params: { phone: 'x' }, cfg: { sem203: true } });
  eq([r.status, r.json.map((n) => n.id)], [200, ['m1']], 'sem a migration 203 a lista continua');
  r = await chamar('get', '/notas/:phone', { params: { phone: 'x' }, cfg: { erroLeitura: true } });
  ok(r.status === 500 && /continuam salvas/.test(r.json.erro), '⚠️ falha de leitura é erro, nunca "nenhuma nota"');

  // Criar
  r = await chamar('post', '/notas', { body: { titulo: 'Nova', texto: 'escrevi muito', user_id: 'outra', origem: 'audio' } });
  const criada = r.tabelas.notas.find((n) => n.titulo === 'Nova');
  ok(r.status === 200 && criada, 'cria');
  eq([criada.user_id, criada.grupo_id, criada.origem], [EU, 'g1', 'texto'], '⚠️ dono/grupo/origem vêm do servidor, nunca do corpo');
  r = await chamar('post', '/notas', { body: { texto: '   ' } });
  eq([r.status, r.tabelas.notas.length], [400, 2], 'nota vazia: 400 e nada gravado');

  // Editar
  r = await chamar('put', '/notas/:id', { params: { id: 'm1' }, body: { texto: 'editada' } });
  eq([r.status, r.json.texto, !!r.json.updated_at], [200, 'editada', true], 'edita e marca updated_at');
  r = await chamar('put', '/notas/:id', { params: { id: 'o1' }, body: { texto: 'invadi' } });
  eq([r.status, r.tabelas.notas.find((n) => n.id === 'o1').texto], [404, 'segredo'], '⚠️ nota de outra pessoa: 404 e intacta');
  r = await chamar('put', '/notas/:id', { params: { id: 'm1' }, body: { texto: 'sem 203' }, cfg: { sem203: true } });
  eq([r.status, r.json && r.json.texto], [200, 'sem 203'], 'sem a 203, editar o texto grava (sem o updated_at)');
  r = await chamar('put', '/notas/:id', { params: { id: 'm1' }, body: { fixada: true }, cfg: { sem203: true } });
  ok(r.status === 503 && !/column|migration/i.test(r.json.erro), 'sem a 203, fixar: 503 sem jargão');
  r = await chamar('put', '/notas/:id', { params: { id: 'm1' }, body: { fixada: true } });
  eq([r.status, r.json.fixada], [200, true], 'fixa');
  r = await chamar('put', '/notas/:id', { params: { id: 'm1' }, body: { user_id: 'outra' } });
  eq([r.status, r.tabelas.notas.find((n) => n.id === 'm1').user_id], [400, EU], 'não dá pra trocar o dono');

  // Apagar
  r = await chamar('delete', '/notas/:id', { params: { id: 'o1' } });
  eq([r.status, r.tabelas.notas.length], [404, 2], '⚠️ apagar nota de outra pessoa: 404 e nada sai');
  r = await chamar('delete', '/notas/:id', { params: { id: 'm1' } });
  eq([r.status, r.tabelas.notas.map((n) => n.id)], [200, ['o1']], 'apaga a minha');

  console.log(`\n${total} verificações · ${falhas.length ? `${falhas.length} FALHAS` : 'todas ok'}`);
  if (falhas.length) { falhas.forEach((f) => console.log('  ✘ ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
