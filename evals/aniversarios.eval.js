// =============================================================================
// EVAL — aniversários e datas comemorativas (migration 205).
//
// Pedido de cliente (Tatiane, nov/2026): datas que se repetem todo ano, com
// lembrete UMA SEMANA antes e NO DIA.
//
//   §1 a regra: repetição anual, 29/02, idade, o que o formulário aceita;
//   §2 quais avisos saem em cada dia (e só uma vez por ano);
//   §3 o cron com banco e WhatsApp falsos: reserva antes de enviar, briefing
//      cobre o "no dia", recusa da Meta tenta de novo, falha ambígua não repete;
//   §4 as rotas do painel (sem a 205 nada quebra; dono confere);
//   §5 o feed da Agenda (todo ano, na janela) e o cron registrado.
//
// Rodar:  node evals/aniversarios.eval.js
// =============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-eval-sem-rede';
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

// ── banco falso (eq / is / select / insert / update / delete; `or` ignorado) ──
function mundo(tabelas = {}, cfg = {}) {
  const log = [];
  const from = (nome) => {
    const filtros = [];
    let modo = 'select', patch = null;
    const casa = (r) => filtros.every(([op, c, v]) => (op === 'eq' ? r[c] === v : op === 'is' ? (r[c] ?? null) === v : true));
    const exec = (unico) => {
      if (cfg.semTabela && nome === 'aniversarios') return { data: null, error: { message: 'relation "public.aniversarios" does not exist' } };
      const rows = (tabelas[nome] = tabelas[nome] || []);
      if (modo === 'select') {
        let l = rows.filter(casa);
        if (cfg.leituraVelha && nome === 'aniversarios') l = l.map((r) => ({ ...r, aviso_semana_ano: null, aviso_dia_ano: null }));
        return { data: unico ? (l[0] || null) : l, error: null };
      }
      if (modo === 'insert') { const row = { id: `n${rows.length + 1}`, created_at: '2026-11-26T12:00:00Z', ...patch }; rows.push(row); log.push(['insert', { ...patch }]); return { data: row, error: null }; }
      if (modo === 'update') {
        const alvo = rows.filter(casa); alvo.forEach((r) => Object.assign(r, patch)); log.push(['update', { ...patch }, alvo.length]);
        if (unico) return alvo[0] ? { data: alvo[0], error: null } : { data: null, error: { message: '0 rows' } };
        return { data: alvo.map((r) => ({ id: r.id })), error: null };
      }
      if (modo === 'delete') { const fora = rows.filter(casa); tabelas[nome] = rows.filter((r) => !fora.includes(r)); return { data: fora.map((r) => ({ id: r.id })), error: null }; }
      return { data: null, error: null };
    };
    const q = new Proxy({}, {
      get(_, k) {
        if (k === 'then') return (a, b) => Promise.resolve(exec(false)).then(a, b);
        if (k === 'single' || k === 'maybeSingle') return () => Promise.resolve(exec(true));
        if (k === 'eq' || k === 'is') return (c, v) => { filtros.push([k, c, v]); return q; };
        if (k === 'insert') return (p) => { modo = 'insert'; patch = p; return q; };
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
  const A = carregar('src/services/aniversarios.js', {});
  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 1. a regra ──');
  eq([A.dataNoAno(29, 2, 2027), A.dataNoAno(29, 2, 2028), A.dataNoAno(5, 12, 2026)], ['2027-02-28', '2028-02-29', '2026-12-05'],
    '⚠️ §1 29/02 cai em 28/02 nos anos comuns (o lembrete não some 3 anos em 4)');
  const ana = { nome: 'Ana', tipo: 'aniversario', dia: 5, mes: 12, ano: 1996 };
  eq(A.ocorrencias(ana, '2026-01-01', '2028-12-31'), ['2026-12-05', '2027-12-05', '2028-12-05'], '§1 todo ano');
  eq(A.ocorrencias(ana, '2026-12-06', '2027-12-04'), [], '§1 fora da janela');
  eq(A.ocorrencias({ ...ana, ano: 2026 }, '2026-01-01', '2027-12-31'), ['2027-12-05'], '§1 nasceu em 2026: o 1º aniversário é em 2027');
  eq(A.proximaOcorrencia(ana, '2026-12-05'), '2026-12-05', '§1 próxima: hoje conta');
  eq(A.proximaOcorrencia(ana, '2026-12-06'), '2027-12-05', '§1 próxima: passou, ano que vem');
  eq([A.rotuloAnos(ana, '2026-12-05'), A.rotuloAnos({ ...ana, ano: 2025 }, '2026-12-05'), A.rotuloAnos({ ...ana, ano: null }, '2026-12-05')],
    ['faz 30 anos', 'faz 1 ano', null], '§1 idade (singular, plural, sem ano)');
  eq(A.rotuloAnos({ ...ana, tipo: 'casamento', ano: 2016 }, '2026-12-05'), '10 anos de casados', '§1 casamento');
  eq(A.rotuloAnos({ ...ana, tipo: 'data', ano: 2016 }, '2026-12-05'), '10 anos', '§1 data comemorativa');
  eq([A.tituloDe(ana), A.tituloDe({ ...ana, tipo: 'casamento', nome: 'Ana e João' }), A.tituloDe({ ...ana, tipo: 'data', nome: 'Formatura' })],
    ['Aniversário: Ana', 'Aniversário de casamento: Ana e João', 'Formatura'], '§1 título (sem "da/do": não adivinha gênero)');

  const v = (b, o) => A.validarAniversario(b, { anoAtual: 2026, ...o });
  eq(v({ nome: '  Ana   Maria ', dia: 5, mes: 12 }), { ok: true, dados: { nome: 'Ana Maria', tipo: 'aniversario', dia: 5, mes: 12, ano: null, lembrete_semana: true, lembrete_dia: true, observacao: null } },
    '§1 padrão: aniversário, os dois lembretes ligados');
  ok(!v({ nome: '', dia: 5, mes: 12 }).ok, '§1 sem nome');
  ok(!v({ nome: 'Ana', dia: 31, mes: 4 }).ok, '§1 31/04 não existe');
  ok(v({ nome: 'Ana', dia: 29, mes: 2 }).ok, '§1 29/02 sem ano vale');
  ok(!v({ nome: 'Ana', dia: 29, mes: 2, ano: 1995 }).ok, '§1 29/02 de 1995 não existiu');
  ok(v({ nome: 'Ana', dia: 29, mes: 2, ano: 1996 }).ok, '§1 29/02 de 1996 existiu');
  ok(!v({ nome: 'Ana', dia: 5, mes: 13 }).ok && !v({ nome: 'Ana', dia: 0, mes: 1 }).ok, '§1 mês/dia fora');
  ok(!v({ nome: 'Ana', dia: 5, mes: 12, ano: 2027 }).ok, '§1 ano no futuro');
  ok(!v({ nome: 'Ana', dia: 31, mes: 12, ano: 2026 }, { hoje: '2026-11-26' }).ok, '⚠️ §1 data deste ano ainda por vir (nascimento no futuro): recusada');
  ok(v({ nome: 'Ana', dia: 1, mes: 3, ano: 2026 }, { hoje: '2026-11-26' }).ok, '§1 data deste ano que já passou: vale');
  ok(!v({ nome: 'Ana', dia: 5, mes: 12, tipo: 'festa' }).ok, '§1 tipo inválido');
  ok(!v({ nome: 'x'.repeat(81), dia: 5, mes: 12 }).ok, '§1 nome longo');
  ok(!v({ nome: 'Ana', dia: 5, mes: 12, lembrete_dia: 'sim' }).ok, '§1 lembrete só booleano');
  eq(v({ lembrete_semana: false }, { parcial: true }), { ok: true, dados: { lembrete_semana: false } }, '§1 edição leva só o que veio');
  ok(!v({}, { parcial: true }).ok, '§1 edição vazia');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 2. quais avisos saem hoje ──');
  const base = { ...ana, id: 'a', lembrete_semana: true, lembrete_dia: true, aviso_semana_ano: null, aviso_dia_ano: null };
  eq(A.avisosDoDia([base], '2026-11-28').map((x) => [x.etapa, x.data, x.ano]), [['semana', '2026-12-05', 2026]], '§2 uma semana antes');
  eq(A.avisosDoDia([base], '2026-12-05').map((x) => [x.etapa, x.data]), [['dia', '2026-12-05']], '§2 no dia');
  eq(A.avisosDoDia([base], '2026-11-29'), [], '§2 outros dias: nada');
  eq(A.avisosDoDia([{ ...base, aviso_semana_ano: 2026 }], '2026-11-28'), [], '⚠️ §2 já avisado este ano: não repete');
  eq(A.avisosDoDia([{ ...base, aviso_semana_ano: 2025 }], '2026-11-28').length, 1, '§2 avisado ano passado: avisa de novo');
  eq(A.avisosDoDia([{ ...base, aviso_dia_ano: 2026 }], '2026-12-05'), [], '⚠️ §2 o "no dia" também não repete no ano');
  eq(A.avisosDoDia([{ ...base, lembrete_semana: false }], '2026-11-28'), [], '§2 lembrete da semana desligado');
  eq(A.avisosDoDia([{ ...base, lembrete_dia: false }], '2026-12-05'), [], '§2 lembrete do dia desligado');
  const jan = { ...base, dia: 3, mes: 1 };
  eq(A.avisosDoDia([jan], '2026-12-27').map((x) => [x.etapa, x.data, x.ano]), [['semana', '2027-01-03', 2027]], '§2 virada de ano: a marca é do ano da DATA');
  const bis = { ...base, dia: 29, mes: 2, ano: null };
  eq(A.avisosDoDia([bis], '2027-02-21').map((x) => [x.etapa, x.data]), [['semana', '2027-02-28']], '⚠️ §2 29/02 em 2027: avisa uma semana antes do 28/02');
  eq(A.avisosDoDia([bis], '2027-02-28').map((x) => x.etapa), ['dia'], '§2 …e no 28/02');
  eq(A.paresDoDia('2027-02-21'), [{ dia: 21, mes: 2 }, { dia: 28, mes: 2 }, { dia: 29, mes: 2 }], '⚠️ §2 a consulta do cron inclui o 29/02 quando a data é 28/02 de ano comum');
  eq(A.paresDoDia('2026-11-28'), [{ dia: 28, mes: 11 }, { dia: 5, mes: 12 }], '§2 a consulta lê só hoje e daqui a 7 dias');

  const tx = A.textoDoAviso({ item: { ...base, observacao: 'gosta de livro' }, etapa: 'semana', data: '2026-12-05' });
  ok(/Aniversário: Ana/.test(tx.texto) && /faz 30 anos/.test(tx.texto) && /gosta de livro/.test(tx.texto), '§2 o texto: quem, idade e a ideia de presente');
  ok(tx.campos.length === 3 && tx.campos.every((c) => c && !/[\n\t]/.test(c)), '⚠️ §2 os 3 campos do modelo: nenhum vazio, sem quebra de linha (a Meta recusaria)');
  ok(/semana/i.test(tx.campos[2]), `§2 o campo de quando diz que é daqui a 1 semana: ${tx.campos[2]}`);
  ok(/hoje/i.test(A.textoDoAviso({ item: base, etapa: 'dia', data: '2026-12-05' }).campos[2]), '§2 no dia diz "é hoje"');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 3. o cron ──');
  async function rodar({ itens, hoje = '2026-11-28', resposta = { ok: true }, briefing = false, avisos = true, phone = '5511999990000', semTabela = false, leituraVelha = false }) {
    const m = mundo({ aniversarios: itens }, { semTabela, leituraVelha });
    const enviados = [];
    const r = await A.avisarAniversarios({
      supabase: m.db, hoje,
      enviar: async (ph, aviso, o) => { enviados.push({ ph, aviso, o }); return typeof resposta === 'function' ? resposta() : resposta; },
      phoneDoUser: async () => phone, avisosLigados: async () => avisos, briefingLigado: async () => briefing,
      log: { warn() {}, error() {} },
    });
    return { r, enviados, m };
  }
  const item = (extra = {}) => ({ ...base, user_id: 'u', grupo_id: 'g', created_at: '2026-10-01T10:00:00Z', ...extra });

  let x = await rodar({ itens: [item()] });
  eq([x.r.enviados, x.enviados.length, x.m.tabelas.aniversarios[0].aviso_semana_ano], [1, 1, 2026], '§3 avisa uma semana antes e marca o ano');
  ok(x.enviados[0].o.seed === 'a-2026-semana', '§3 seed estável (mesma abertura se repetir)');
  const depois = await A.avisarAniversarios({ supabase: x.m.db, hoje: '2026-11-28', enviar: async () => { throw new Error('não podia enviar de novo'); },
    phoneDoUser: async () => 'p', avisosLigados: async () => true, briefingLigado: async () => false, log: { warn() {}, error() {} } });
  eq(depois.enviados, 0, '⚠️ §3 rodar de novo no mesmo dia não manda outro');

  x = await rodar({ itens: [item()], hoje: '2026-12-05', briefing: true });
  eq([x.r.enviados, x.r.cobertosPeloBriefing, x.m.tabelas.aniversarios[0].aviso_dia_ano], [0, 1, 2026], '§3 no dia com briefing ligado: o briefing avisa (marca e não duplica)');
  x = await rodar({ itens: [item({ created_at: '2026-12-05T13:00:00Z' })], hoje: '2026-12-05', briefing: true });
  eq(x.r.enviados, 1, '§3 …mas data cadastrada HOJE (o briefing pode ter perdido) avisa');
  x = await rodar({ itens: [item()], hoje: '2026-12-05', briefing: false });
  eq(x.r.enviados, 1, '§3 no dia sem briefing: avisa');
  x = await rodar({ itens: [item()], hoje: '2026-11-28', briefing: true });
  eq(x.r.enviados, 1, '§3 o da semana sai mesmo com briefing (o briefing só fala de hoje)');

  x = await rodar({ itens: [item({ aviso_semana_ano: 2026 })], leituraVelha: true });
  eq([x.r.enviados, x.enviados.length], [0, 0], '⚠️ §3 outro servidor reservou entre a leitura e a escrita: este NÃO envia (reserva atômica)');
  x = await rodar({ itens: [item()], avisos: false });
  eq([x.enviados.length, x.m.tabelas.aniversarios[0].aviso_semana_ano], [0, null], '§3 avisos desligados: não envia nem marca');
  x = await rodar({ itens: [item()], phone: null });
  eq([x.enviados.length, x.m.tabelas.aniversarios[0].aviso_semana_ano], [0, null], '§3 sem telefone: não envia nem marca');

  x = await rodar({ itens: [item()], resposta: { ok: false, nadaSaiu: true } });
  eq([x.r.tentarDeNovo, x.m.tabelas.aniversarios[0].aviso_semana_ano], [1, null], '⚠️ §3 a Meta provou que nada saiu: desfaz a marca (tenta na próxima rodada)');
  x = await rodar({ itens: [item()], resposta: { ok: false, nadaSaiu: false } });
  eq([x.r.falhas, x.m.tabelas.aniversarios[0].aviso_semana_ano], [1, 2026], '⚠️ §3 falha ambígua: fica marcado (dois avisos iguais é pior)');
  x = await rodar({ itens: [item()], resposta: () => { throw new Error('rede'); } });
  eq(x.r.falhas, 1, '§3 erro num aviso não derruba a rodada');
  x = await rodar({ itens: [item({ id: 'a' }), item({ id: 'b', nome: 'Bia' })] });
  eq(x.r.enviados, 2, '§3 dois aniversários no mesmo dia: dois avisos');
  x = await rodar({ itens: [item()], semTabela: true });
  eq(x.r, { enviados: 0, cobertosPeloBriefing: 0, falhas: 0, tentarDeNovo: 0 }, '§3 sem a migration 205: não faz nada e não quebra');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 4. as rotas ──');
  async function chamar(metodo, caminho, { params = {}, body = {}, tabelas = {}, cfg = {} }) {
    const m = mundo(tabelas, cfg);
    m.tabelas.users = [{ id: 'u', grupo_ativo: 'g', plano: 'premium' }];
    const router = carregar('src/routes/grow.js', { 'db/supabase': m.db, 'middlewares/auth': (rq, rs, nx) => nx() });
    const camada = router.stack.find((c) => c.route?.path === caminho && c.route?.methods?.[metodo]);
    const pilha = camada.route.stack.map((s) => s.handle);
    let status = 200, json = null;
    const req = { params, body, query: {}, authUser: { id: 'u' } };
    const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; } };
    let i = 0;
    const prox = async () => { const h = pilha[i++]; if (h) await h(req, res, prox); };
    await prox();
    for (let k = 0; k < 200 && json === null; k++) await new Promise((r2) => setTimeout(r2, 5));
    return { status, json, ...m };
  }
  let r = await chamar('get', '/aniversarios/:phone', { params: { phone: 'x' }, cfg: { semTabela: true } });
  eq([r.status, r.json], [200, { itens: [], liberado: false }], '§4 sem a 205: lista vazia avisando que ainda não liberou');
  r = await chamar('post', '/aniversarios', { body: { nome: 'Ana', dia: 5, mes: 12 }, cfg: { semTabela: true } });
  ok(r.status === 503 && !/relation|column|migration/i.test(r.json.erro), '§4 sem a 205: criar responde 503 sem jargão');
  r = await chamar('post', '/aniversarios', { body: { nome: 'Ana', dia: 5, mes: 12, ano: 1996, user_id: 'outro', aviso_dia_ano: 2026 } });
  const criado = r.tabelas.aniversarios[0];
  eq([r.status, criado.user_id, criado.grupo_id, criado.aviso_dia_ano], [200, 'u', 'g', undefined], '⚠️ §4 cria; dono e grupo vêm do servidor, marcas de aviso não vêm do corpo');
  r = await chamar('post', '/aniversarios', { body: { nome: 'Ana', dia: 31, mes: 4 } });
  eq(r.status, 400, '§4 data inexistente: 400');

  const comUm = () => ({ aniversarios: [{ id: 'k', user_id: 'u', nome: 'Ana', tipo: 'aniversario', dia: 5, mes: 12, ano: 1996, aviso_semana_ano: 2026, aviso_dia_ano: 2026 }] });
  r = await chamar('put', '/aniversarios/:id', { params: { id: 'k' }, body: { dia: 20 }, tabelas: comUm() });
  eq([r.status, r.json.dia, r.tabelas.aniversarios[0].aviso_semana_ano], [200, 20, null], '⚠️ §4 mudou a data: os avisos deste ano voltam a valer');
  r = await chamar('put', '/aniversarios/:id', { params: { id: 'k' }, body: { nome: 'Ana Maria' }, tabelas: comUm() });
  eq([r.status, r.tabelas.aniversarios[0].aviso_semana_ano], [200, 2026], '§4 mudou só o nome: marcas ficam (não avisa de novo)');
  r = await chamar('put', '/aniversarios/:id', { params: { id: 'k' }, body: { dia: 29, mes: 2 }, tabelas: comUm() });
  eq(r.status, 200, '§4 29/02 com o ano 1996 guardado vale (1996 foi bissexto)');
  r = await chamar('put', '/aniversarios/:id', { params: { id: 'k' }, body: { dia: 29, mes: 2 }, tabelas: { aniversarios: [{ ...comUm().aniversarios[0], ano: 1995 }] } });
  eq(r.status, 400, '⚠️ §4 29/02 com o ano 1995 guardado não (1995 não teve 29/02)');
  r = await chamar('put', '/aniversarios/:id', { params: { id: 'k' }, body: { mes: 4 }, tabelas: comUm() });
  eq([r.status, r.json && r.json.dia, r.json && r.json.mes], [200, 5, 4], '§4 mudar só o mês mantém o dia salvo');
  r = await chamar('put', '/aniversarios/:id', { params: { id: 'k' }, body: { mes: 4, dia: 31 }, tabelas: comUm() });
  eq(r.status, 400, '§4 31/04 na edição: 400');
  r = await chamar('put', '/aniversarios/:id', { params: { id: 'k' }, body: { ano: 1995 }, tabelas: { aniversarios: [{ ...comUm().aniversarios[0], dia: 29, mes: 2 }] } });
  eq(r.status, 400, '§4 mudar só o ano pra um ano sem 29/02: 400');
  r = await chamar('put', '/aniversarios/:id', { params: { id: 'k' }, body: { nome: 'Invasor' }, tabelas: { aniversarios: [{ ...comUm().aniversarios[0], user_id: 'outro' }] } });
  eq([r.status, r.tabelas.aniversarios[0].nome], [404, 'Ana'], '⚠️ §4 de outra pessoa: 404 e intacto');
  r = await chamar('delete', '/aniversarios/:id', { params: { id: 'k' }, tabelas: { aniversarios: [{ ...comUm().aniversarios[0], user_id: 'outro' }] } });
  eq([r.status, r.tabelas.aniversarios.length], [404, 1], '⚠️ §4 apagar de outra pessoa: 404');
  r = await chamar('delete', '/aniversarios/:id', { params: { id: 'k' }, tabelas: comUm() });
  eq([r.status, r.tabelas.aniversarios.length], [200, 0], '§4 apaga');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 5. feed e cron ──');
  {
    const m = mundo({ aniversarios: [
      { id: 'a', user_id: 'u', grupo_id: 'g', nome: 'Ana', tipo: 'aniversario', dia: 5, mes: 12, ano: 1996 },
      { id: 'b', user_id: 'outra', grupo_id: 'g', nome: 'De outra pessoa', tipo: 'aniversario', dia: 6, mes: 12, ano: null },
    ] });
    const { montarFeed } = carregar('src/services/agendaFeed.js', { 'db/supabase': m.db });
    const ev = (await montarFeed('g', '2026-11-26', '2027-12-31', { userId: 'u' })).filter((e) => e.source === 'aniversario');
    eq(ev.map((e) => [e.id, e.data, e.titulo, e.anos]), [['aniv-a-2026-12-05', '2026-12-05', 'Aniversário: Ana', 'faz 30 anos'], ['aniv-a-2027-12-05', '2027-12-05', 'Aniversário: Ana', 'faz 31 anos']],
      '§5 feed: todo ano dentro da janela, com a idade de cada ano; o de outra pessoa não aparece');
    ok(ev.every((e) => e.editavel === false && e.raw?.id === 'a'), '§5 feed: abre o formulário próprio (raw), não o de compromisso');
    const m2 = mundo({}, { semTabela: true });
    const f2 = carregar('src/services/agendaFeed.js', { 'db/supabase': m2.db });
    eq((await f2.montarFeed('g', '2026-11-26', '2026-12-31', { userId: 'u' })).filter((e) => e.source === 'aniversario'), [], '§5 sem a 205: o feed segue sem aniversários');

    const agendados = [];
    process.env.CRONS_ATIVOS = '1';
    carregar('src/jobs/index.js', {
      'node-cron': { schedule: (expr, fn) => { agendados.push({ expr, fn: String(fn) }); return { stop() {} }; } },
      'db/supabase': mundo().db,
    });
    const job = agendados.find((a) => /avisarAniversarios/.test(a.fn));
    ok(job && job.expr === '*/30 * * * *', '§5 o cron está agendado (a cada 30 min)');
    ok(job && /HORA_AVISO \* 60/.test(job.fn) && /22 \* 60/.test(job.fn), '§5 …só das 9h às 22h');
    ok(job && /aviso: 'compromissos'/.test(job.fn) && /campos: aviso\.campos/.test(job.fn), '§5 …pelo modelo do lembrete de compromisso (já aprovado na Meta)');
  }

  console.log(`\n${total} verificações · ${falhas.length ? `${falhas.length} FALHAS` : 'todas ok'}`);
  if (falhas.length) { for (const f of falhas) console.log('  ✘ ' + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
