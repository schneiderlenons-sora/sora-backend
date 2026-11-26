// =============================================================================
// EVAL — registro de humor com DATA (services/humorRegistro.js + rotas).
//
// Pedido de cliente (Tatiane, nov/2026): escolher a data do registro de humor
// (dormiu depois da meia-noite, esqueceu um dia) e corrigir a data depois.
//
//   §1 a data: o "hoje" é de São Paulo (era UTC); nada no futuro; até 1 ano;
//   §2 o que o formulário manda;
//   §3 as rotas: registrar num dia (substitui e avisa), mover de dia (dia
//      ocupado = 409, nada some), apagar, e só a própria pessoa;
//   §4 o WhatsApp: "me sinto bem" grava no dia de São Paulo.
//
// Rodar:  node evals/humorRegistro.eval.js
// =============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-eval-sem-rede';
process.env.CRONS_ATIVOS = '0';
const Module = require('module');
const path = require('path');
const RAIZ = path.resolve(__dirname, '..');

const falhas = [];
let total = 0;
const ok = (c, m) => { total++; if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}\n      esperado ${JSON.stringify(b)}\n      veio     ${JSON.stringify(a)}`);

const LOAD_ORIGINAL = Module._load;
let stubsAtuais = {};
Module._load = function (req, parent, isMain) {
  for (const [suf, exp] of Object.entries(stubsAtuais)) if (req.endsWith(suf)) return exp;
  return LOAD_ORIGINAL.call(this, req, parent, isMain);
};
function carregar(rel, stubs) {
  stubsAtuais = stubs;
  for (const k of Object.keys(require.cache)) if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  return require(path.join(RAIZ, rel));
}

// ── banco falso: eq / neq / gte / limit / upsert(onConflict) / update / delete ──
function mundo(tabelas = {}) {
  const log = [];
  const from = (nome) => {
    const filtros = [];
    let modo = 'select', patch = null, conflito = null, lim = null;
    const casa = (r) => filtros.every(([op, c, v]) => (op === 'eq' ? r[c] === v : op === 'neq' ? r[c] !== v
      : op === 'gte' ? String(r[c]) >= String(v) : true));
    const exec = (unico) => {
      const rows = (tabelas[nome] = tabelas[nome] || []);
      if (modo === 'select') { let l = rows.filter(casa); if (lim) l = l.slice(0, lim); return { data: unico ? (l[0] || null) : l, error: null }; }
      if (modo === 'upsert') {
        const cols = (conflito || '').split(',');
        const ja = rows.find((r) => cols.every((c) => r[c] === patch[c]));
        if (ja) { Object.assign(ja, patch); log.push(['upsert-atualizou', { ...patch }]); return { data: ja, error: null }; }
        const row = { id: `h${rows.length + 1}`, ...patch }; rows.push(row); log.push(['upsert-criou', { ...patch }]);
        return { data: row, error: null };
      }
      if (modo === 'update') {
        const alvo = rows.filter(casa); alvo.forEach((r) => Object.assign(r, patch)); log.push(['update', { ...patch }]);
        return unico ? (alvo[0] ? { data: alvo[0], error: null } : { data: null, error: { message: '0 rows' } }) : { data: alvo, error: null };
      }
      if (modo === 'delete') { const fora = rows.filter(casa); tabelas[nome] = rows.filter((r) => !fora.includes(r)); return { data: fora.map((r) => ({ id: r.id })), error: null }; }
      return { data: null, error: null };
    };
    const q = new Proxy({}, {
      get(_, k) {
        if (k === 'then') return (a, b) => Promise.resolve(exec(false)).then(a, b);
        if (k === 'single' || k === 'maybeSingle') return () => Promise.resolve(exec(true));
        if (k === 'eq' || k === 'neq' || k === 'gte') return (c, v) => { filtros.push([k, c, v]); return q; };
        if (k === 'limit') return (n) => { lim = n; return q; };
        if (k === 'upsert') return (p, o) => { modo = 'upsert'; patch = p; conflito = o && o.onConflict; return q; };
        if (k === 'update') return (p) => { modo = 'update'; patch = p; return q; };
        if (k === 'delete') return () => { modo = 'delete'; return q; };
        return () => q;
      },
    });
    return q;
  };
  return { db: { from }, tabelas, log };
}

(async () => {
  const H = carregar('src/services/humorRegistro.js', {});
  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 1. a data ──');
  eq(H.hojeSP(new Date('2026-11-27T01:30:00Z')), '2026-11-26', '⚠️ §1 22h30 em São Paulo ainda é dia 26 (em UTC já seria 27)');
  eq(H.hojeSP(new Date('2026-11-27T03:30:00Z')), '2026-11-27', '§1 00h30 em São Paulo já é dia 27');
  const HOJE = '2026-11-27';
  eq(H.validarData(null, HOJE), { ok: true, data: HOJE }, '§1 sem data: hoje');
  eq(H.validarData('2026-11-26', HOJE), { ok: true, data: '2026-11-26' }, '§1 ontem (o caso da madrugada)');
  ok(!H.validarData('2026-11-28', HOJE).ok, '§1 amanhã: recusado');
  ok(/ainda não chegou/.test(H.validarData('2026-11-28', HOJE).erro), '§1 …com motivo claro');
  ok(H.validarData('2025-11-26', HOJE).ok, '§1 366 dias atrás: vale');
  ok(!H.validarData('2025-11-25', HOJE).ok, '§1 mais de 1 ano atrás: recusado');
  ok(!H.validarData('2026-02-30', HOJE).ok && !H.validarData('27/11/2026', HOJE).ok, '§1 data inválida');
  eq(H.validarData('2026-11-26T15:00:00Z', HOJE), { ok: true, data: '2026-11-26' }, '§1 data com hora: só o dia');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 2. o formulário ──');
  const l = (b, o = {}) => H.limparHumor(b, { hoje: HOJE, ...o });
  eq(l({ humor: 4 }), { ok: true, dados: { humor: 4, data: HOJE, energia: null, sono_horas: null, nota: null, gratidao: null } }, '§2 só o humor: o resto vazio, dia de hoje');
  eq(l({ humor: '5', data: '2026-11-26', energia: 3, sono_horas: '7,5', nota: '  dormi tarde ', gratidao: [' café ', '', 'amigos'] }).dados,
    { humor: 5, data: '2026-11-26', energia: 3, sono_horas: 7.5, nota: 'dormi tarde', gratidao: ['café', 'amigos'] }, '§2 completo (vírgula no sono, gratidão limpa)');
  ok(!l({ humor: 0 }).ok && !l({ humor: 6 }).ok && !l({}).ok, '§2 humor de 1 a 5, obrigatório');
  ok(!l({ humor: 3, energia: 9 }).ok, '§2 energia de 1 a 5');
  ok(!l({ humor: 3, sono_horas: 25 }).ok && !l({ humor: 3, sono_horas: 'muito' }).ok, '§2 sono de 0 a 24');
  ok(!l({ humor: 3, gratidao: ['a', 'b', 'c', 'd'] }).ok, '§2 até 3 gratidões');
  ok(!l({ humor: 3, nota: 'x'.repeat(401) }).ok, '§2 anotação longa');
  ok(!l({ humor: 3, data: '2026-11-28' }).ok, '§2 data no futuro: recusada');
  eq(l({ data: '2026-11-20' }, { parcial: true }), { ok: true, dados: { data: '2026-11-20' } }, '§2 edição: só a data');
  ok(!l({}, { parcial: true }).ok, '§2 edição vazia');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 3. as rotas ──');
  const hoje = H.hojeSP();
  const ontem = carregar('src/services/pesoRegistro.js', {}).somarDias(hoje, -1);
  const anteontem = carregar('src/services/pesoRegistro.js', {}).somarDias(hoje, -2);
  async function chamar(metodo, caminho, { params = {}, body = {}, query = {}, tabelas = {} }) {
    const m = mundo(tabelas);
    m.tabelas.users = [{ id: 'u', grupo_ativo: 'g', plano: 'premium' }];
    const router = carregar('src/routes/grow.js', { 'db/supabase': m.db, 'middlewares/auth': (rq, rs, nx) => nx() });
    const camada = router.stack.find((c) => c.route?.path === caminho && c.route?.methods?.[metodo]);
    const pilha = camada.route.stack.map((s) => s.handle);
    let status = 200, json = null;
    const req = { params, body, query, authUser: { id: 'u' } };
    const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; } };
    let i = 0;
    const prox = async () => { const h = pilha[i++]; if (h) await h(req, res, prox); };
    await prox();
    for (let k = 0; k < 200 && json === null; k++) await new Promise((r2) => setTimeout(r2, 5));
    return { status, json, ...m };
  }
  const base = () => ({ registros_humor: [
    { id: 'a', grupo_id: 'g', user_id: 'u', data: anteontem, humor: 3 },
    { id: 'b', grupo_id: 'g', user_id: 'u', data: hoje, humor: 2, nota: 'era sobre ontem' },
    { id: 'z', grupo_id: 'g', user_id: 'outra', data: ontem, humor: 5 },
  ] });

  let r = await chamar('post', '/humor', { body: { humor: 4 } });
  eq([r.status, r.json.data, r.json.substituiu], [200, hoje, false], '⚠️ §3 sem data: o dia de SÃO PAULO');
  r = await chamar('post', '/humor', { body: { humor: 4, data: ontem }, tabelas: base() });
  eq([r.status, r.json.data, r.json.substituiu, r.tabelas.registros_humor.length], [200, ontem, false, 4], '§3 registrar pra ontem (dia livre)');
  r = await chamar('post', '/humor', { body: { humor: 5, data: anteontem }, tabelas: base() });
  eq([r.status, r.json.substituiu, r.tabelas.registros_humor.find((x) => x.id === 'a').humor], [200, true, 5], '§3 dia que já tinha registro: substitui e AVISA');
  r = await chamar('post', '/humor', { body: { humor: 4, data: '2099-01-01' }, tabelas: base() });
  eq([r.status, r.tabelas.registros_humor.length], [400, 3], '§3 futuro: 400 e nada gravado');
  r = await chamar('post', '/humor', { body: { humor: 4, user_id: 'outra', grupo_id: 'x' } });
  eq([r.json.user_id, r.json.grupo_id], ['u', 'g'], '⚠️ §3 dono e grupo vêm do servidor');

  // O caso da Tatiane: registrou depois da meia-noite, era sobre o dia anterior
  r = await chamar('put', '/humor/:id', { params: { id: 'b' }, body: { data: ontem }, tabelas: base() });
  eq([r.status, r.json.data, r.json.nota], [200, ontem, 'era sobre ontem'], '⚠️ §3 corrigir a data: o registro vai pra ontem, inteiro');
  r = await chamar('put', '/humor/:id', { params: { id: 'b' }, body: { data: anteontem }, tabelas: base() });
  eq([r.status, r.json.codigo, r.tabelas.registros_humor.find((x) => x.id === 'b').data], [409, 'dia_ocupado', hoje],
    '⚠️ §3 mover pra um dia que já tem registro: 409 e NADA muda (nada some em silêncio)');
  r = await chamar('put', '/humor/:id', { params: { id: 'b' }, body: { data: ontem }, tabelas: { registros_humor: [...base().registros_humor] } });
  eq(r.status, 200, '§3 o registro de OUTRA pessoa no mesmo dia não bloqueia o seu');
  r = await chamar('put', '/humor/:id', { params: { id: 'b' }, body: { humor: 4, nota: 'melhorou' }, tabelas: base() });
  eq([r.status, r.json.humor, r.json.data], [200, 4, hoje], '§3 editar sem mudar a data');
  r = await chamar('put', '/humor/:id', { params: { id: 'b' }, body: { data: '2099-01-01' }, tabelas: base() });
  eq([r.status, r.tabelas.registros_humor.find((x) => x.id === 'b').data], [400, hoje], '§3 mover pro futuro: 400');
  r = await chamar('put', '/humor/:id', { params: { id: 'z' }, body: { humor: 1 }, tabelas: base() });
  eq([r.status, r.tabelas.registros_humor.find((x) => x.id === 'z').humor], [404, 5], '⚠️ §3 de outra pessoa: 404 e intacto');
  r = await chamar('delete', '/humor/:id', { params: { id: 'z' }, tabelas: base() });
  eq([r.status, r.tabelas.registros_humor.length], [404, 3], '⚠️ §3 apagar de outra pessoa: 404');
  r = await chamar('delete', '/humor/:id', { params: { id: 'b' }, tabelas: base() });
  eq([r.status, r.tabelas.registros_humor.map((x) => x.id)], [200, ['a', 'z']], '§3 apagar o próprio');
  r = await chamar('get', '/humor/:phone', { params: { phone: 'x' }, query: { dias: 30 }, tabelas: base() });
  eq(r.json.map((x) => x.id).sort(), ['a', 'b'], '§3 a lista: só os da pessoa');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 4. o WhatsApp ──');
  {
    const ups = [];
    const tabela = () => {
      const p = new Proxy({}, {
        get(_, k) {
          if (k === 'then') return (a, b) => Promise.resolve({ data: [], error: null }).then(a, b);
          if (k === 'upsert') return (o) => { ups.push(o); return p; };
          if (k === 'single' || k === 'maybeSingle') return () => Promise.resolve({ data: null, error: null });
          return () => p;
        },
      });
      return p;
    };
    const enviados = [];
    const handleGrow = carregar('src/handlers/grow.js', {
      'db/supabase': { from: tabela },
      'services/mensageiro': { enviarTexto: async (_, t) => enviados.push(t), enviarImagem: async () => {}, enviarBotaoLink: async (_, o) => enviados.push(o.message) },
      'services/growShare': { growShareCfg: async () => ({ casa: false }) },
      'services/ia': { interpretarGrowComando: async () => null },
    });
    const logOrig = console.log; console.log = () => {};
    try { await handleGrow('me sinto bem', { phone: '5500', grupoId: 'g', user: { id: 'u', plano: 'basico' } }); } finally { console.log = logOrig; }
    const reg = ups.find((o) => o && 'humor' in o);
    eq([reg && reg.data, reg && reg.humor], [H.hojeSP(), 4], '⚠️ §4 "me sinto bem": gravado no dia de São Paulo');
    ok(/Humor registrado/.test(enviados[0] || ''), '§4 e confirma');
  }

  console.log(`\n${total} verificações · ${falhas.length ? `${falhas.length} FALHAS` : 'todas ok'}`);
  if (falhas.length) { for (const f of falhas) console.log('  ✘ ' + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
