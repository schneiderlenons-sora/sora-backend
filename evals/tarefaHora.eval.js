// =============================================================================
// EVAL — horário opcional da tarefa: regra, rotas reais, agenda e lembrete.
// Rodar:  npm run eval:tarefa-hora
// =============================================================================
process.env.SUPABASE_URL = 'http://falso.local';
process.env.SUPABASE_KEY = 'falso';
process.env.SUPABASE_SERVICE_KEY = 'falso';
const path = require('path');

let temColuna = true;
let linhas = [];
const escritas = [];
const semColuna = { message: "Could not find the 'hora' column of 'tarefas' in the schema cache" };
function from(tabela) {
  let op = 'select', dado = null, cols = '*', unica = false;
  const filtros = [];
  const q = {
    select(c) { if (c) cols = c; return q; },
    insert(d) { op = 'insert'; dado = d; return q; },
    update(d) { op = 'update'; dado = d; return q; },
    delete() { op = 'delete'; return q; },
    eq(c, v) { filtros.push((r) => r[c] === v); return q; },
    not() { return q; }, gte() { return q; }, lte() { return q; }, order() { return q; }, in() { return q; },
    limit() { return q; }, neq() { return q; }, or() { return q; }, is() { return q; }, lt() { return q; }, gt() { return q; },
    single() { unica = true; return q; }, maybeSingle() { unica = true; return q; },
    then(ok, ruim) {
      return Promise.resolve().then(() => {
        if (tabela !== 'tarefas') return { data: unica ? null : [], error: null };
        if (!temColuna && ((op === 'select' && /\bhora\b/.test(cols)) || (dado && 'hora' in dado))) return { data: null, error: semColuna };
        const casa = (r) => filtros.every((f) => f(r));
        if (op === 'insert') { const n = { id: `t${linhas.length + 1}`, concluida: false, ...dado }; linhas.push(n); escritas.push(dado); return { data: n, error: null }; }
        if (op === 'update') { const alvo = linhas.filter(casa); alvo.forEach((r) => Object.assign(r, dado)); escritas.push(dado); return { data: unica ? alvo[0] || null : alvo, error: null }; }
        if (op === 'delete') { linhas = linhas.filter((r) => !casa(r)); return { data: null, error: null }; }
        return { data: linhas.filter(casa), error: null };
      }).then(ok, ruim);
    },
  };
  return q;
}
const alvoDb = require.resolve(path.join(__dirname, '../src/db/supabase'));
require.cache[alvoDb] = { id: alvoDb, filename: alvoDb, loaded: true, exports: { from, rpc: async () => ({ data: null, error: null }) } };

const H = require('../src/services/tarefaHora');
const L = require('../src/services/lembreteTarefas');
const router = require('../src/routes/grow');

const falhas = []; let total = 0;
const eq = (a, b, m) => { total++; if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push(`${m}\n      esperado ${JSON.stringify(b)}\n      veio     ${JSON.stringify(a)}`); };

const rota = (metodo, caminho) => { const c = router.stack.find((l) => l.route && l.route.path === caminho && l.route.methods[metodo]); return c.route.stack[c.route.stack.length - 1].handle; };
async function chamar(metodo, caminho, { body = {}, id, user = 'eu' } = {}) {
  let status = 200, corpo = null;
  const res = { status(s) { status = s; return this; }, json(j) { corpo = j; return this; } };
  await rota(metodo, caminho)({ body, params: { id }, query: {}, userRow: { id: user, grupo_ativo: 'g' } }, res, () => {});
  return { status, corpo };
}
const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

(async () => {
  // ── §1 Formato ──────────────────────────────────────────────────────────
  eq([H.normalizarHora('9:05'), H.normalizarHora('14:30'), H.normalizarHora('23:59:00'), H.normalizarHora('00:00')], ['09:05', '14:30', '23:59', '00:00'], '§1 válidos');
  eq([H.normalizarHora(''), H.normalizarHora(null), H.normalizarHora(undefined)], [null, null, null], '§1 sem horário');
  for (const v of ['24:00', '12:60', 'meio-dia', '1230', '12h', 14]) eq(H.normalizarHora(v), undefined, `§1 inválido ${v}`);

  // ── §2 Prazo + hora ─────────────────────────────────────────────────────
  const c = (corpo, criando = true) => H.camposDePrazo(corpo, { criando, hoje: '2026-11-28' }).campos;
  eq(c({ data_vencimento: '2026-12-01', hora: '8:00' }), { data_vencimento: '2026-12-01', hora: '08:00' }, '§2 com os dois');
  eq(c({ hora: '10:00' }), { hora: '10:00', data_vencimento: '2026-11-28' }, '§2 criar só com hora vale hoje');
  eq(c({ hora: '10:00' }, false), { hora: '10:00' }, '§2 editar só a hora não mexe na data');
  eq(c({ data_vencimento: null }, false), { data_vencimento: null, hora: null }, '§2 tirar a data tira a hora');
  eq(c({ data_vencimento: null, hora: '10:00' }, false), { data_vencimento: '2026-11-28', hora: '10:00' }, '§2 hora sem dia vale hoje');
  eq(c({ data_vencimento: '2026-12-01', hora: '' }, false), { data_vencimento: '2026-12-01', hora: null }, '§2 "sem horário"');
  eq(c({ titulo: 'x' }, false), {}, '§2 edição sem prazo não escreve prazo');
  eq(c({ concluida: true }, false), {}, '§2 concluir não toca em data nem hora');
  eq(!!H.camposDePrazo({ hora: '99:99' }, { criando: true, hoje: 'x' }).erro, true, '§2 inválida é erro');

  // ── §3 Rotas, com a migration ───────────────────────────────────────────
  linhas = []; temColuna = true;
  let r = await chamar('post', '/tarefas', { body: { titulo: 'A', data_vencimento: '2026-12-01', hora: '15:00' } });
  eq([r.status, linhas[0].hora, linhas[0].data_vencimento], [200, '15:00', '2026-12-01'], '§3 cria com horário');
  r = await chamar('post', '/tarefas', { body: { titulo: 'B', hora: null, data_vencimento: null } });
  eq([r.status, 'hora' in escritas[escritas.length - 1]], [200, false], '§3 sem horário a coluna nem é enviada');
  r = await chamar('post', '/tarefas', { body: { titulo: 'C', hora: '25:00' } });
  eq([r.status, linhas.length], [400, 2], '§3 horário inválido não cria');
  r = await chamar('put', '/tarefas/:id', { id: 't1', body: { hora: '16:30', data_vencimento: '2026-12-02' } });
  eq([r.status, linhas[0].hora, linhas[0].data_vencimento], [200, '16:30', '2026-12-02'], '§3 edita');
  r = await chamar('put', '/tarefas/:id', { id: 't1', body: { concluida: true } });
  eq([linhas[0].hora, linhas[0].data_vencimento, linhas[0].status_kanban], ['16:30', '2026-12-02', 'concluida'], '§3 concluir mantém prazo');
  r = await chamar('put', '/tarefas/:id', { id: 't1', body: { data_vencimento: null, hora: null } });
  eq([linhas[0].hora, linhas[0].data_vencimento], [null, null], '§3 tira prazo e hora');
  r = await chamar('put', '/tarefas/:id', { id: 't1', user: 'outro', body: { titulo: 'invadi' } });
  eq([r.status, linhas[0].titulo], [404, 'A'], '§3 tarefa de outra pessoa não é editada');
  await chamar('delete', '/tarefas/:id', { id: 't1', user: 'outro' });
  eq(linhas.length, 2, '§3 nem apagada');
  await chamar('delete', '/tarefas/:id', { id: 't1' });
  eq(linhas.length, 1, '§3 a própria apaga');

  // ── §4 Sem a migration 210 ──────────────────────────────────────────────
  linhas = []; temColuna = false;
  r = await chamar('post', '/tarefas', { body: { titulo: 'A', data_vencimento: '2026-12-01', hora: null } });
  eq([r.status, linhas.length], [200, 1], '§4 criar sem horário funciona');
  r = await chamar('post', '/tarefas', { body: { titulo: 'B', hora: '15:00' } });
  eq([r.status, linhas.length, /migration|column|coluna/i.test(r.corpo.erro)], [503, 1, false], '§4 com horário: aviso sem jargão, nada criado');
  r = await chamar('put', '/tarefas/:id', { id: 't1', body: { titulo: 'A2', data_vencimento: '2026-12-03', hora: null } });
  eq([r.status, linhas[0].titulo], [200, 'A2'], '§4 editar sem horário funciona');
  r = await chamar('put', '/tarefas/:id', { id: 't1', body: { hora: '10:00' } });
  eq(r.status, 503, '§4 pôr horário avisa');
  let lido = await H.lerComHora((cols) => from('tarefas').select(cols).eq('user_id', 'eu'), 'id, titulo');
  eq([lido.error, lido.data.length], [null, 1], '§4 leitura cai pra sem a coluna');
  temColuna = true;
  lido = await H.lerComHora(async (cols) => ({ data: cols, error: null }), 'id');
  eq(lido.data, 'id, hora', '§4 com a coluna, pede a hora');
  let n = 0;
  lido = await H.lerComHora(async () => { n++; return { data: null, error: { message: 'timeout' } }; }, 'id');
  eq([n, lido.error.message], [1, 'timeout'], '§4 outro erro não é mascarado');

  // ── §5 Agenda ───────────────────────────────────────────────────────────
  const { montarFeed } = require('../src/services/agendaFeed');
  for (const com of [true, false]) {
    temColuna = com;
    linhas = [{ id: 't9', user_id: 'eu', titulo: 'Ligar', prioridade: 'media', concluida: false, data_vencimento: '2026-12-01T00:00:00+00:00', hora: com ? '14:00' : undefined }];
    const feed = await montarFeed('g', '2026-11-28', '2026-12-05', { userId: 'eu' });
    const ev = (Array.isArray(feed) ? feed : feed.eventos || []).find((e) => e.source === 'tarefa');
    eq(ev ? [ev.data, ev.hora] : null, ['2026-12-01', com ? '14:00' : null], `§5 agenda ${com ? 'com' : 'sem'} a coluna`);
  }

  // ── §6 Lembrete ─────────────────────────────────────────────────────────
  const t = (titulo, data, hora, prioridade = 'media') => ({ id: titulo, titulo, concluida: false, data_vencimento: data, hora, prioridade, created_at: '' });
  const res = L.tarefasDoLembrete({ hojeStr: '2026-11-28', limite: 10, tarefas: [
    t('sem hora', '2026-11-28', null, 'alta'), t('tarde', '2026-11-28', '18:00'), t('cedo', '2026-11-28', '08:00', 'baixa'),
    t('ontem', '2026-11-27', '23:00'), t('sem data', null, '10:00'),
  ] });
  eq(res.itens.map((i) => i.titulo), ['ontem', 'cedo', 'tarde', 'sem hora', 'sem data'], '§6 dia, depois relógio, depois prioridade');
  eq(L.linhaDaTarefa(res.itens[1]), '• cedo — vence hoje às 08:00', '§6 a linha diz o horário');
  eq(L.linhaDaTarefa(res.itens[3]), '• sem hora — vence hoje', '§6 sem horário igual a antes');
  eq(L.linhaDaTarefa(res.itens[4]), '• sem data', '§6 sem data não mostra hora');

  console.log(`${total} verificações · ${falhas.length ? `${falhas.length} FALHAS` : 'todas ok'}`);
  if (falhas.length) { for (const f of falhas) console.log('  ✘ ' + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
