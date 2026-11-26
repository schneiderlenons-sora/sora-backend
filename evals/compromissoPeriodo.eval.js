// =============================================================================
// EVAL — compromisso de MAIS DE UM DIA (migration 204).
//
// Pedido de cliente (nov/2026): um evento de dois dias seguidos (27 e 28/11,
// dia todo) teve de ser cadastrado duas vezes. Agora o compromisso tem um fim
// opcional e aparece em cada dia ("dia 1 de 2").
//
// O que este eval trava:
//   §1 a regra do "até" (validarPeriodo) e a dos dias (diasNoIntervalo…);
//   §2 a leitura da frase no WhatsApp — e o que NÃO pode virar período
//      ("reunião de 9 a 11" é horário; "dias 10 e 20" são dois dias soltos);
//   §3 o feed da Agenda: o evento aparece em cada dia, inclusive o que COMEÇOU
//      antes da janela; o de um dia sai IGUAL a antes;
//   §4 as rotas do painel: criar, editar (mudar o início mantém a duração),
//      e sem a migration 204 nada quebra pra quem marca um dia só;
//   §5 o WhatsApp real: marcar "de 27 a 28/11", a confirmação, a lista
//      "minha agenda" e a IA não poder resumir o período num dia.
//
// Rodar:  node evals/compromissoPeriodo.eval.js
// =============================================================================
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-eval-sem-rede';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.CRONS_ATIVOS = '0';
const Module = require('module');
const path = require('path');
const RAIZ = path.resolve(__dirname, '..');

const falhas = [];
let total = 0;
const ok = (c, m) => { total++; if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}\n      esperado ${JSON.stringify(b)}\n      veio     ${JSON.stringify(a)}`);

const P = require(path.join(RAIZ, 'src/services/compromissoPeriodo.js'));

// ── banco falso: filtra eq/gte/lte de verdade; o resto só encadeia ──────────
function bancoFalso(tabelas, cfg = {}) {
  const log = [];
  const from = (nome) => {
    const filtros = [];
    let modo = 'select', patch = null;
    const casa = (r) => filtros.every(([op, c, v]) => (op === 'eq' ? r[c] === v
      : op === 'gte' ? String(r[c]) >= String(v) : op === 'lte' ? String(r[c]) <= String(v) : true));
    const exec = (unico) => {
      const rows = (tabelas[nome] = tabelas[nome] || []);
      if (modo === 'select') {
        log.push(['select', nome, filtros.slice()]);
        const l = rows.filter(casa);
        return { data: unico ? (l[0] || null) : l, error: null };
      }
      if (cfg.sem204 && patch && 'data_fim' in patch) {
        log.push(['recusado', nome, { ...patch }]);
        return { data: null, error: { message: 'column "data_fim" of relation "compromissos" does not exist' } };
      }
      if (modo === 'insert') {
        const row = { id: `c${rows.length + 1}`, ...patch };
        rows.push(row); log.push(['insert', nome, { ...patch }]);
        return { data: row, error: null };
      }
      if (modo === 'update') {
        const alvo = rows.filter(casa);
        alvo.forEach((r) => Object.assign(r, patch)); log.push(['update', nome, { ...patch }]);
        if (unico) return alvo[0] ? { data: alvo[0], error: null } : { data: null, error: { message: '0 rows' } };
        return { data: alvo, error: null };
      }
      if (modo === 'delete') { tabelas[nome] = rows.filter((r) => !casa(r)); return { data: null, error: null }; }
      return { data: null, error: null };
    };
    const q = new Proxy({}, {
      get(_, k) {
        if (k === 'then') return (a, b) => Promise.resolve(exec(false)).then(a, b);
        if (k === 'single' || k === 'maybeSingle') return () => Promise.resolve(exec(true));
        if (k === 'eq' || k === 'gte' || k === 'lte') return (c, v) => { filtros.push([k, c, v]); return q; };
        if (k === 'insert') return (p) => { modo = 'insert'; patch = p; return q; };
        if (k === 'update') return (p) => { modo = 'update'; patch = p; return q; };
        if (k === 'delete') return () => { modo = 'delete'; return q; };
        return () => q; // select, order, limit, not, in…
      },
    });
    return q;
  };
  return { db: { from }, log };
}

// Carrega um módulo do backend com stubs (por sufixo do caminho pedido).
// ⚠️ Os stubs FICAM valendo até o próximo `carregar`: parte do código faz
// `require` só na hora de usar (rotinaSync, ia) e escaparia de um stub que
// valesse só durante o carregamento.
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

(async () => {
  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 1. regra do período ──');
  eq(P.validarPeriodo('2026-11-27', '2026-11-28'), { ok: true, dataFim: '2026-11-28' }, '§1 dois dias');
  eq(P.validarPeriodo('2026-11-27', null), { ok: true, dataFim: null }, '§1 sem fim = um dia');
  eq(P.validarPeriodo('2026-11-27', ''), { ok: true, dataFim: null }, '§1 fim vazio = um dia');
  eq(P.validarPeriodo('2026-11-27', '2026-11-27'), { ok: true, dataFim: null }, '§1 fim igual ao início = um dia (nunca grava fim = início)');
  ok(!P.validarPeriodo('2026-11-27', '2026-11-26').ok, '§1 fim antes do início é recusado');
  ok(/depois/.test(P.validarPeriodo('2026-11-27', '2026-11-26').erro), '§1 …com motivo claro');
  ok(P.validarPeriodo('2026-01-01', '2026-03-01').ok, `§1 ${P.MAX_DIAS} dias passa (01/01→01/03 = 60 dias)`);
  ok(!P.validarPeriodo('2026-01-01', '2026-03-02').ok, `§1 mais de ${P.MAX_DIAS} dias é recusado`);
  ok(!P.validarPeriodo('2026-11-27', '2026-11-31').ok, '§1 data inexistente (31/11) não passa');
  ok(!P.validarPeriodo('', '2026-11-28').ok, '§1 sem início não passa');
  eq(P.validarPeriodo('2026-11-27T00:00:00+00:00', '2026-11-28'), { ok: true, dataFim: '2026-11-28' }, '§1 início vindo com hora do banco');

  const ev = { data: '2026-11-27', data_fim: '2026-11-29' };
  eq(P.diasNoIntervalo(ev, '2026-11-01', '2026-11-30'), [
    { data: '2026-11-27', dia: 1, total: 3 }, { data: '2026-11-28', dia: 2, total: 3 }, { data: '2026-11-29', dia: 3, total: 3 },
  ], '§1 três dias, cada um com a posição');
  eq(P.diasNoIntervalo(ev, '2026-11-28', '2026-11-28'), [{ data: '2026-11-28', dia: 2, total: 3 }],
    '⚠️ §1 evento que COMEÇOU antes da janela aparece no dia dela (é o "hoje" do 2º dia)');
  eq(P.diasNoIntervalo({ data: '2026-11-27' }, '2026-11-01', '2026-11-30'), [{ data: '2026-11-27', dia: 1, total: 1 }], '§1 um dia só');
  eq(P.diasNoIntervalo({ data: '2026-11-27', data_fim: null }, '2026-11-28', '2026-11-30'), [], '§1 fora da janela');
  eq(P.diasNoIntervalo({ data: '2026-11-27', data_fim: '2026-11-20' }, '2026-11-01', '2026-11-30'),
    [{ data: '2026-11-27', dia: 1, total: 1 }], '§1 fim torto no banco (antes do início) vira um dia, nunca laço');
  eq(P.diasNoIntervalo({ data: '2026-01-01', data_fim: '2030-01-01' }, '2026-01-01', '2030-12-31').length, P.MAX_DIAS,
    '§1 fim absurdo no banco tem teto');
  eq(P.inicioDaBusca('2026-11-28'), '2026-09-30', '§1 busca começa 59 dias antes (pega evento de até 60 dias)');
  ok(P.cruzaIntervalo(ev, '2026-11-29', '2026-12-05'), '§1 cruza pelo último dia');
  ok(!P.cruzaIntervalo(ev, '2026-11-30', '2026-12-05'), '§1 não cruza depois do fim');
  eq(P.fimAoMoverInicio(ev, '2026-12-10'), '2026-12-12', '§1 mudar o início mantém os 3 dias');
  eq(P.fimAoMoverInicio({ data: '2026-11-27' }, '2026-12-10'), null, '§1 evento de um dia segue de um dia');
  eq(P.sufixoDoDia(2, 3), ' (dia 2 de 3)', '§1 sufixo');
  eq(P.sufixoDoDia(1, 1), '', '§1 sem sufixo em evento de um dia');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 2. a frase do WhatsApp ──');
  const AGORA = new Date(2026, 10, 26, 10); // 26/11/2026
  const per = (f) => { const r = P.lerPeriodoNaFrase(f, AGORA); return r && [r.inicio, r.fim, r.matched]; };
  eq(per('marca dia de campo de 27 a 28/11'), ['2026-11-27', '2026-11-28', 'de 27 a 28/11'], '§2 o caso do pedido');
  eq(per('dia de campo dias 27 e 28/11'), ['2026-11-27', '2026-11-28', 'dias 27 e 28/11'], '§2 "dias 27 e 28"');
  eq(per('Dia de Campo 27 e 28/11'), ['2026-11-27', '2026-11-28', '27 e 28/11'], '§2 "27 e 28/11" (com mês)');
  eq(per('viagem do dia 27 ao dia 30'), ['2026-11-27', '2026-11-30', 'do dia 27 ao dia 30'], '§2 "do dia X ao dia Y"');
  eq(per('congresso dia 27 a 29 de novembro'), ['2026-11-27', '2026-11-29', 'dia 27 a 29 de novembro'], '§2 mês escrito');
  eq(per('feira de 2 até 4 de dezembro às 9h'), ['2026-12-02', '2026-12-04', 'de 2 até 4 de dezembro'], '§2 "até" + hora depois');
  eq(per('evento de 1 a 3 de março'), ['2027-03-01', '2027-03-03', 'de 1 a 3 de março'], '§2 mês escrito já passado = próximo ano');
  eq(per('viagem de 30/12 a 02/01'), ['2026-12-30', '2027-01-02', 'de 30/12 a 02/01'], '§2 vira o ano');
  eq(per('de 30 a 2/12'), ['2026-11-30', '2026-12-02', 'de 30 a 2/12'], '§2 vira o mês ("de 30 a 2/12")');
  eq(per('férias 27/11 a 3'), ['2026-11-27', '2026-12-03', '27/11 a 3'], '§2 só o início com mês');
  eq(per('viagem de 1 a 31/03/2027'), ['2027-03-01', '2027-03-31', 'de 1 a 31/03/2027'], '§2 ano escrito');
  eq(per('dia 27 a 29'), ['2026-11-27', '2026-11-29', 'dia 27 a 29'], '§2 só "dia", mês corrente');
  eq(per('dia 20 a 22'), ['2026-12-20', '2026-12-22', 'dia 20 a 22'], '§2 só "dia" e já passou: mês que vem (igual "dia 20")');
  // ⚠️ o que NÃO é período
  eq(per('reunião de 9 a 11'), null, '⚠️ §2 "de 9 a 11" é horário, não três dias');
  eq(per('reunião de 9 a 11h'), null, '⚠️ §2 "de 9 a 11h"');
  eq(per('reunião das 9 às 11 dia 27/11'), null, '§2 "das 9 às 11"');
  eq(per('dias 10 e 20/12'), null, '⚠️ §2 "dias 10 e 20" são dois dias soltos, não um período');
  eq(per('reunião 27/11 a 30 minutos do centro'), null, '⚠️ §2 "a 30 minutos" é distância, não data');
  eq(per('jantar de 2 a 3 pessoas dia 27/11'), null, '§2 "de 2 a 3 pessoas"');
  eq(per('marca dentista 28/11'), null, '§2 um dia só não é período');
  eq(per('de 28 a 28/11'), null, '§2 mesmo dia não é período');
  eq(per('de 31 a 31/12/2026'), null, '§2 mesmo dia, com ano');
  eq(per('viagem de 1/1 a 15/3/2027'), null, `§2 mais de ${P.MAX_DIAS} dias não vira período`);
  eq(per('de 30 a 31/11'), null, '§2 31/11 não existe');
  eq(per('rua 25 de março'), null, '§2 endereço');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 3. o feed da Agenda ──');
  {
    const tabelas = {
      compromissos: [
        { id: 'a', user_id: 'u', grupo_id: 'g', titulo: 'Dentista', data: '2026-11-27', hora: '15:00', cor: '#111', local: null, data_fim: null },
        { id: 'b', user_id: 'u', grupo_id: 'g', titulo: 'Dia de campo', data: '2026-11-27', hora: null, cor: '#222', local: 'Fazenda', data_fim: '2026-11-28' },
        { id: 'c', user_id: 'u', grupo_id: 'g', titulo: 'Congresso', data: '2026-11-20', hora: '08:00', cor: '#333', local: null, data_fim: '2026-11-29' },
        { id: 'd', user_id: 'u', grupo_id: 'g', titulo: 'Antigo', data: '2026-10-01', hora: null, cor: '#444', local: null, data_fim: '2026-10-03' },
        { id: 'z', user_id: 'outro', grupo_id: 'g', titulo: 'De outra pessoa', data: '2026-11-27', hora: null, cor: '#555', local: null, data_fim: null },
      ],
    };
    const { db, log } = bancoFalso(tabelas);
    const { montarFeed } = carregar('src/services/agendaFeed.js', { 'db/supabase': db });
    const eventos = (await montarFeed('g', '2026-11-26', '2026-11-30', { userId: 'u' }))
      .filter((e) => e.source === 'compromisso');
    const resumo = eventos.map((e) => [e.id, e.data, e.periodo ? `${e.periodo.dia}/${e.periodo.total}` : '-']);
    eq(resumo.filter((r) => r[0].startsWith('comp-b')), [['comp-b-2026-11-27', '2026-11-27', '1/2'], ['comp-b-2026-11-28', '2026-11-28', '2/2']],
      '§3 dois dias: aparece nos dois, "1 de 2" e "2 de 2"');
    eq(resumo.filter((r) => r[0].startsWith('comp-c')).map((r) => [r[1], r[2]]),
      [['2026-11-26', '7/10'], ['2026-11-27', '8/10'], ['2026-11-28', '9/10'], ['2026-11-29', '10/10']],
      '⚠️ §3 começou ANTES da janela (20/11) e aparece nos dias dela');
    ok(!resumo.some((r) => r[0].startsWith('comp-d')), '§3 terminou antes da janela: não aparece');
    ok(!resumo.some((r) => r[0].startsWith('comp-z')), '§3 compromisso de outra pessoa não aparece');
    const dentista = eventos.find((e) => e.id === 'comp-a');
    eq(Object.keys(dentista), ['id', 'source', 'titulo', 'data', 'hora', 'cor', 'local', 'deeplink', 'editavel', 'raw'],
      '⚠️ §3 evento de um dia: mesmo id e mesmos campos de antes (sem "periodo")');
    eq([dentista.data, dentista.hora, dentista.titulo], ['2026-11-27', '15:00', 'Dentista'], '§3 …e mesmos valores');
    const dia2 = eventos.find((e) => e.id === 'comp-b-2026-11-28');
    eq([dia2.titulo, dia2.hora, dia2.local, dia2.editavel, dia2.raw.id, dia2.periodo],
      ['Dia de campo', null, 'Fazenda', true, 'b', { dia: 2, total: 2, inicio: '2026-11-27', fim: '2026-11-28' }],
      '§3 o 2º dia leva o compromisso inteiro (editar abre o evento todo)');
    const consulta = log.find((l) => l[0] === 'select' && l[1] === 'compromissos');
    eq(consulta[2].filter((f) => f[1] === 'data'), [['gte', 'data', P.inicioDaBusca('2026-11-26')], ['lte', 'data', '2026-11-30']],
      '⚠️ §3 a consulta busca pelo INÍCIO desde antes da janela e nunca filtra por data_fim');

    // sem a migration 204 as linhas vêm sem a coluna: tudo de um dia, como antes
    const semColuna = { compromissos: tabelas.compromissos.map(({ data_fim, ...r }) => r) };
    const f2 = carregar('src/services/agendaFeed.js', { 'db/supabase': bancoFalso(semColuna).db });
    const ev2 = (await f2.montarFeed('g', '2026-11-26', '2026-11-30', { userId: 'u' })).filter((e) => e.source === 'compromisso');
    eq(ev2.map((e) => e.id).sort(), ['comp-a', 'comp-b'], '§3 sem a 204: só os que começam na janela, de um dia (como antes)');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 4. as rotas do painel ──');
  async function chamar(metodo, caminho, { params = {}, body = {}, query = {}, tabelas, cfg = {} }) {
    const { db, log } = bancoFalso(tabelas, cfg);
    const router = carregar('src/routes/grow.js', {
      'db/supabase': db,
      'middlewares/auth': (rq, rs, nx) => nx(),
      'services/rotinaSync': { sincronizarCompromisso: async () => null },
    });
    const camada = router.stack.find((c) => c.route?.path === caminho && c.route?.methods?.[metodo]);
    const pilha = camada.route.stack.map((s) => s.handle);
    let status = 200, json = null;
    const req = { params, body, query, authUser: { id: 'u' } };
    const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; } };
    let i = 0;
    const prox = async () => { const h = pilha[i++]; if (h) await h(req, res, prox); };
    await prox();
    for (let k = 0; k < 200 && json === null; k++) await new Promise((r) => setTimeout(r, 5));
    return { status, json, log, tabelas };
  }
  const usuarios = () => [{ id: 'u', grupo_ativo: 'g', plano: 'premium' }];
  const novo = { titulo: 'Dia de campo', data: '2026-11-27', hora: null, categoria: 'estudos', lembrete_ativo: true, lembrete_antecedencia: 0 };

  let r = await chamar('post', '/compromissos', { body: { ...novo, data_fim: '2026-11-28' }, tabelas: { users: usuarios() } });
  eq([r.status, r.tabelas.compromissos?.[0]?.data, r.tabelas.compromissos?.[0]?.data_fim], [200, '2026-11-27', '2026-11-28'], '§4 cria de dois dias');
  r = await chamar('post', '/compromissos', { body: { ...novo, data_fim: null }, tabelas: { users: usuarios() } });
  ok(r.status === 200 && !('data_fim' in r.tabelas.compromissos[0]), '⚠️ §4 um dia só: grava SEM a coluna nova (igual a antes)');
  r = await chamar('post', '/compromissos', { body: { ...novo, data_fim: '2026-11-27' }, tabelas: { users: usuarios() } });
  ok(r.status === 200 && !('data_fim' in r.tabelas.compromissos[0]), '§4 fim igual ao início: um dia só');
  r = await chamar('post', '/compromissos', { body: { ...novo, data_fim: '2026-11-20' }, tabelas: { users: usuarios() } });
  ok(r.status === 400 && /depois/.test(r.json.erro) && !(r.tabelas.compromissos || []).length, '§4 fim antes do início: 400 e nada gravado');
  r = await chamar('post', '/compromissos', { body: { ...novo, data_fim: '2026-11-28' }, tabelas: { users: usuarios() }, cfg: { sem204: true } });
  ok(r.status === 503 && !/column|migration|data_fim/i.test(r.json.erro), '§4 sem a 204, marcar "até": 503 sem jargão');
  r = await chamar('post', '/compromissos', { body: { ...novo, data_fim: null }, tabelas: { users: usuarios() }, cfg: { sem204: true } });
  eq(r.status, 200, '⚠️ §4 sem a 204, um dia só continua gravando');

  const comDoisDias = () => ({ users: usuarios(), compromissos: [{ id: 'k', user_id: 'u', grupo_id: 'g', titulo: 'Dia de campo', data: '2026-11-27', data_fim: '2026-11-28', hora: null, lembrete_enviado: true }] });
  r = await chamar('put', '/compromissos/:id', { params: { id: 'k' }, body: { data: '2026-12-04' }, tabelas: comDoisDias() });
  eq([r.status, r.json.data, r.json.data_fim, r.json.lembrete_enviado], [200, '2026-12-04', '2026-12-05', false],
    '⚠️ §4 mudar só o início mantém os 2 dias (e o lembrete volta a valer)');
  r = await chamar('put', '/compromissos/:id', { params: { id: 'k' }, body: { data: '2026-11-27', data_fim: null }, tabelas: comDoisDias() });
  eq([r.status, r.json.data_fim], [200, null], '§4 voltar pra um dia só');
  r = await chamar('put', '/compromissos/:id', { params: { id: 'k' }, body: { data_fim: '2026-11-26' }, tabelas: comDoisDias() });
  ok(r.status === 400 && r.tabelas.compromissos[0].data_fim === '2026-11-28', '§4 fim antes do início: 400 e intacto');
  r = await chamar('put', '/compromissos/:id', { params: { id: 'k' }, body: { titulo: 'Novo nome' }, tabelas: comDoisDias() });
  eq([r.status, r.json.titulo, r.json.data_fim], [200, 'Novo nome', '2026-11-28'], '§4 mudar só o título não mexe no período');
  r = await chamar('put', '/compromissos/:id', { params: { id: 'k' }, body: { data: '2026-12-04' },
    tabelas: { users: usuarios(), compromissos: [{ id: 'k', user_id: 'outro', data: '2026-11-27', data_fim: '2026-11-28' }] } });
  eq(r.status, 404, '⚠️ §4 compromisso de outra pessoa: 404');
  r = await chamar('put', '/compromissos/:id', { params: { id: 'k' }, body: { data_fim: '2020-01-01' },
    tabelas: { users: usuarios(), compromissos: [{ id: 'k', user_id: 'outro', data: '2026-11-27', data_fim: '2026-11-28' }] } });
  eq(r.status, 404, '⚠️ §4 compromisso de outra pessoa com fim inválido: 404, nunca 400 (não revela que existe)');

  const umDiaSem204 = () => ({ users: usuarios(), compromissos: [{ id: 'k', user_id: 'u', grupo_id: 'g', titulo: 'Dentista', data: '2026-11-27', hora: '15:00' }] });
  r = await chamar('put', '/compromissos/:id', { params: { id: 'k' }, body: { titulo: 'Dentista', data: '2026-11-30', data_fim: null, hora: '16:00' }, tabelas: umDiaSem204(), cfg: { sem204: true } });
  eq([r.status, r.json && r.json.data, r.json && r.json.hora], [200, '2026-11-30', '16:00'],
    '⚠️ §4 sem a 204, editar um evento de um dia (a tela manda data_fim: null) grava normalmente');
  r = await chamar('put', '/compromissos/:id', { params: { id: 'k' }, body: { data: '2026-11-30', data_fim: '2026-12-01' }, tabelas: umDiaSem204(), cfg: { sem204: true } });
  ok(r.status === 503 && r.tabelas.compromissos[0].data === '2026-11-27', '§4 sem a 204, pôr "até": 503 e nada muda');

  r = await chamar('get', '/compromissos/:phone', { params: { phone: 'x' }, query: { de: '2026-11-28', ate: '2026-12-31' },
    tabelas: { users: usuarios(), compromissos: [
      { id: 'p', user_id: 'u', data: '2026-11-27', data_fim: '2026-11-28' },
      { id: 'q', user_id: 'u', data: '2026-11-27', data_fim: null },
      { id: 's', user_id: 'u', data: '2026-12-02', data_fim: null },
    ] } });
  eq(r.json.itens.map((c) => c.id), ['p', 's'], '§4 listar por período traz o que começou antes e ainda acontece');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 5. o WhatsApp de verdade ──');
  {
    let inserts = [], enviados = [], iaResposta = null, recusar204 = false, tabelas = {};
    const tabela = (nome) => {
      const st = { op: 'select', payload: null, de: null, ate: null };
      const res = () => {
        if (st.op === 'insert') {
          if (recusar204 && 'data_fim' in st.payload) return { data: null, error: { message: 'column "data_fim" of relation "compromissos" does not exist' } };
          const row = { id: 'novo', ...st.payload }; inserts.push({ nome, row }); return { data: row, error: null };
        }
        const rows = (tabelas[nome] || []).filter((r) => (st.de == null || r.data >= st.de) && (st.ate == null || r.data <= st.ate));
        return { data: rows, error: null };
      };
      const p = new Proxy({}, {
        get(_, k) {
          if (k === 'then') return (a, b) => Promise.resolve(res()).then(a, b);
          if (k === 'insert') return (o) => { st.op = 'insert'; st.payload = o; return p; };
          if (k === 'single' || k === 'maybeSingle') return () => Promise.resolve(res());
          if (k === 'gte') return (c, v) => { if (c === 'data') st.de = v; return p; };
          if (k === 'lte') return (c, v) => { if (c === 'data') st.ate = v; return p; };
          return () => p;
        },
      });
      return p;
    };
    const handleGrow = carregar('src/handlers/grow.js', {
      'db/supabase': { from: tabela },
      'services/mensageiro': { enviarTexto: async (_, t) => enviados.push(t), enviarImagem: async () => {}, enviarBotaoLink: async (_, o) => enviados.push(o.message) },
      'services/growShare': { growShareCfg: async () => ({ casa: false }) },
      'services/rotinaSync': { sincronizarCompromisso: async () => {} },
      'services/ia': { interpretarGrowComando: async () => iaResposta },
    });
    const ctx = { phone: '5500000000000', grupoId: 'g', user: { id: 'u', plano: 'basico' } };
    const marcar = async (frase, ia = null) => {
      inserts = []; enviados = []; iaResposta = ia;
      const log = console.log; console.log = () => {};
      try { await handleGrow(frase, ctx); } finally { console.log = log; }
      return inserts.find((x) => x.nome === 'compromissos')?.row || null;
    };

    let c = await marcar('marca Dia de Campo Agrofácil de 27 a 28/11/2027');
    eq([c?.titulo, c?.data, c?.data_fim, c?.hora], ['Dia de Campo Agrofácil', '2027-11-27', '2027-11-28', null], '⚠️ §5 o caso do pedido: um compromisso, dois dias, título limpo');
    ok(/sáb, 27\/11 a dom, 28\/11 \(dia todo\)/.test(enviados[0] || ''), `§5 a confirmação diz o período: ${JSON.stringify((enviados[0] || '').split('\n')[3])}`);
    ok(/\(do 1º dia\)/.test(enviados[0] || ''), '§5 …e que o aviso é do 1º dia');

    c = await marcar('marca congresso dias 3 e 4/12/2027 às 8h');
    eq([c?.titulo, c?.data, c?.data_fim, c?.hora], ['Congresso', '2027-12-03', '2027-12-04', '08:00'], '§5 "dias 3 e 4" com hora');

    c = await marcar('marca dentista 28/11/2027 15h');
    eq([c?.titulo, c?.data, c?.hora, c && 'data_fim' in c], ['Dentista', '2027-11-28', '15:00', false], '⚠️ §5 um dia só: igual a antes, sem a coluna nova');
    ok(!/ a /.test((enviados[0] || '').split('\n')[3] || ''), '§5 …e a confirmação de sempre');

    c = await marcar('marca reunião amanhã de 9 a 11');
    ok(c && !('data_fim' in c), '⚠️ §5 "de 9 a 11" continua sendo horário, não período');

    recusar204 = true;
    c = await marcar('marca dia de campo de 27 a 28/11/2027');
    recusar204 = false;
    eq([c?.data, c && 'data_fim' in c], ['2027-11-27', false], '§5 sem a 204: marca o 1º dia (melhor que não marcar)');
    ok(/Por enquanto marquei só o 1º dia/.test(enviados[0] || ''), '§5 …e diz isso, sem jargão');
    ok(!/a dom, 28\/11/.test(enviados[0] || ''), '§5 …sem prometer o 2º dia');

    // A IA resumiu o período num dia só → o período da pessoa vence
    c = await marcar('Dia de campo agrofácil 27 e 28/11/2027 o dia todo', 'marca Dia de campo agrofácil dia 27');
    eq([c?.data, c?.data_fim], ['2027-11-27', '2027-11-28'], '⚠️ §5 a IA não pode resumir o período num dia');

    // "minha agenda": o de vários dias aparece UMA vez, dizendo até quando vai
    const { hojeSP, somarDias } = require(path.join(RAIZ, 'src/services/agendaWhatsapp.js'));
    const hoje = hojeSP();
    tabelas = { compromissos: [
      { titulo: 'Começou ontem', data: somarDias(hoje, -1), data_fim: somarDias(hoje, 1), hora: null, local: null },
      { titulo: 'Dentista', data: somarDias(hoje, 2), data_fim: null, hora: '15:00', local: null },
      { titulo: 'Viagem', data: somarDias(hoje, 3), data_fim: somarDias(hoje, 5), hora: null, local: null },
      { titulo: 'Já acabou', data: somarDias(hoje, -5), data_fim: somarDias(hoje, -2), hora: null, local: null },
    ] };
    await marcar('minha agenda');
    const txt = enviados[0] || '';
    ok(/Começou ontem \(dia 2 de 3, até/.test(txt), `§5 lista: começou antes e aparece hoje como "dia 2 de 3" — ${JSON.stringify(txt.split('\n').slice(0, 4))}`);
    ok(/Viagem \(até /.test(txt), '§5 lista: o de vários dias diz até quando vai');
    eq((txt.match(/Viagem/g) || []).length, 1, '§5 lista: aparece UMA vez só');
    ok(!/Já acabou/.test(txt), '§5 lista: o que já terminou não aparece');
    ok(/Dentista$/m.test(txt), '§5 lista: o de um dia sai como antes');
    tabelas = {};
  }

  console.log(`\n${total} verificações · ${falhas.length ? `${falhas.length} FALHAS` : 'todas ok'}`);
  if (falhas.length) { for (const f of falhas) console.log('  ✘ ' + f); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
