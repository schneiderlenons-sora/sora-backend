// =============================================================================
// EVAL — cota de 500 MB por pessoa no Drive (services/espacoDrive.js).
//
// Decisão do dono (nov/2026): sem cota, um cliente podia encher o
// armazenamento do projeto inteiro (1 GB no plano gratuito do Supabase).
//
//   §1 a regra pura: o que conta, o que cabe, o texto que a pessoa lê;
//   §2 a medição no storage (paginada; órfão antigo não conta contra a pessoa);
//   §3 as rotas do painel: subir barrado quando não cabe, a barra de espaço,
//      apagar PASTA/SUBPASTA leva os arquivos junto (antes ficavam pra sempre),
//      trocar o arquivo de um item apaga o antigo, e caminho de outra pessoa
//      nunca é aceito nem apagado;
//   §4 o WhatsApp: cheio nem baixa; o que não cabe não sobe.
//
// Rodar:  node evals/espacoDrive.eval.js
// =============================================================================
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

const MB = 1024 * 1024;
const EU = 'aaaaaaaa-0000-0000-0000-000000000001';
const OUTRA = 'bbbbbbbb-0000-0000-0000-000000000002';
const AGORA = Date.parse('2026-11-26T15:00:00Z');
const velho = '2026-11-01T10:00:00Z';
const novo = new Date(AGORA - 60 * 60 * 1000).toISOString(); // 1h atrás

// ── banco + storage falsos ──────────────────────────────────────────────────
function mundo(cfg = {}) {
  const tabelas = cfg.tabelas || {};
  const storage = cfg.storage || {}; // path → { size, created_at }
  const log = { removidos: [], assinados: [], uploads: [], listas: 0 };
  const from = (nome) => {
    const filtros = [];
    let modo = 'select', patch = null, faixa = null;
    const casa = (r) => filtros.every(([op, c, v]) => (op === 'eq' ? r[c] === v
      : op === 'in' ? v.includes(r[c]) : op === 'notnull' ? r[c] != null : true));
    const exec = (unico) => {
      if (cfg.erroTabela === nome && modo === 'select') return { data: null, error: { message: 'timeout' } };
      const rows = (tabelas[nome] = tabelas[nome] || []);
      if (modo === 'select') {
        let l = rows.filter(casa);
        if (faixa) l = l.slice(faixa[0], faixa[1] + 1);
        return { data: unico ? (l[0] || null) : l, error: null };
      }
      if (modo === 'insert') { const row = { id: `i${rows.length + 1}`, ...patch }; rows.push(row); return { data: row, error: null }; }
      if (modo === 'update') {
        const alvo = rows.filter(casa); alvo.forEach((r) => Object.assign(r, patch));
        return unico ? (alvo[0] ? { data: alvo[0], error: null } : { data: null, error: { message: '0 rows' } }) : { data: alvo, error: null };
      }
      if (modo === 'delete') {
        if (cfg.erroApagar) return { data: null, error: { message: 'falhou' } };
        const fora = rows.filter(casa);
        tabelas[nome] = rows.filter((r) => !fora.includes(r));
        // cascata do banco: quadro → seções → itens
        if (nome === 'dados_quadros') { const ids = fora.map((r) => r.id); const sec = (tabelas.dados_secoes || []).filter((s) => ids.includes(s.quadro_id)).map((s) => s.id); tabelas.dados_secoes = (tabelas.dados_secoes || []).filter((s) => !ids.includes(s.quadro_id)); tabelas.dados_itens = (tabelas.dados_itens || []).filter((i) => !sec.includes(i.secao_id)); }
        if (nome === 'dados_secoes') { const ids = fora.map((r) => r.id); tabelas.dados_itens = (tabelas.dados_itens || []).filter((i) => !ids.includes(i.secao_id)); }
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };
    const q = new Proxy({}, {
      get(_, k) {
        if (k === 'then') return (a, b) => Promise.resolve(exec(false)).then(a, b);
        if (k === 'single' || k === 'maybeSingle') return () => Promise.resolve(exec(true));
        if (k === 'eq') return (c, v) => { filtros.push(['eq', c, v]); return q; };
        if (k === 'in') return (c, v) => { filtros.push(['in', c, v]); return q; };
        if (k === 'not') return (c) => { filtros.push(['notnull', c]); return q; };
        if (k === 'range') return (a, b) => { faixa = [a, b]; return q; };
        if (k === 'insert') return (p) => { modo = 'insert'; patch = p; return q; };
        if (k === 'update') return (p) => { modo = 'update'; patch = p; return q; };
        if (k === 'delete') return () => { modo = 'delete'; return q; };
        return () => q;
      },
    });
    return q;
  };
  const bucket = () => ({
    async list(prefixo, { limit, offset }) {
      log.listas++;
      if (cfg.erroStorage) return { data: null, error: { message: 'storage fora' } };
      const nomes = Object.keys(storage).filter((p) => p.startsWith(`${prefixo}/`)).sort();
      const objs = nomes.map((p) => ({ id: p, name: p.slice(prefixo.length + 1), metadata: { size: storage[p].size }, created_at: storage[p].created_at }));
      return { data: objs.slice(offset, offset + limit), error: null };
    },
    async remove(paths) { for (const p of paths) { log.removidos.push(p); delete storage[p]; } return { data: [], error: null }; },
    async createSignedUploadUrl(p) { log.assinados.push(p); return { data: { token: 't' }, error: null }; },
    async createSignedUrl() { return { data: { signedUrl: 'u' }, error: null }; },
    async upload(p, buf) { log.uploads.push(p); storage[p] = { size: buf.length, created_at: new Date().toISOString() }; return { data: {}, error: null }; },
  });
  return { db: { from, storage: { from: bucket } }, tabelas, storage, log };
}

(async () => {
  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 1. a regra ──');
  const E = carregar('src/services/espacoDrive.js', {});
  eq(E.COTA_BYTES, 500 * MB, '§1 cota de 500 MB');
  eq(E.MAX_ARQUIVO, 10 * MB, '§1 cada arquivo até 10 MB (igual ao bucket)');
  eq([E.fmtMB(0), E.fmtMB(1.8 * MB), E.fmtMB(500 * MB), E.fmtMB(1000), E.fmtMB(123.45 * MB)], ['0 MB', '1,8 MB', '500 MB', '0,1 MB', '123 MB'], '§1 texto do tamanho');
  ok(E.caminhoDaPessoa(EU, `${EU}/x-a.pdf`), '§1 caminho da própria pasta');
  ok(!E.caminhoDaPessoa(EU, `${OUTRA}/x-a.pdf`), '⚠️ §1 caminho de outra pessoa não');
  ok(!E.caminhoDaPessoa(EU, `${EU}/../${OUTRA}/x.pdf`), '§1 nada de ".."');
  ok(!E.caminhoDaPessoa(EU, `${EU}/`), '§1 a pasta em si não é arquivo');
  ok(!E.caminhoDaPessoa(EU, null) && !E.caminhoDaPessoa('', 'x/y'), '§1 vazio não');

  const objs = [
    { name: 'a.pdf', metadata: { size: 3 * MB }, created_at: velho },
    { name: 'orfao-velho.pdf', metadata: { size: 5 * MB }, created_at: velho },
    { name: 'subindo-agora.pdf', metadata: { size: 2 * MB }, created_at: novo },
    { name: 'sem-data.pdf', metadata: { size: 1 * MB }, created_at: null },
  ];
  eq(E.somarUso(EU, objs, new Set([`${EU}/a.pdf`]), AGORA), { bytes: 6 * MB, arquivos: 3 },
    '⚠️ §1 órfão antigo NÃO conta contra a pessoa; o recente (upload em andamento) e o sem data contam');
  eq(E.somarUso(EU, objs, null, AGORA), { bytes: 11 * MB, arquivos: 4 }, '§1 sem conseguir ler os itens, conta TUDO');

  eq(E.decidirUpload(100 * MB, 5 * MB), { ok: true }, '§1 cabe');
  eq(E.decidirUpload(495 * MB, 5 * MB), { ok: true }, '§1 cabe no limite exato');
  ok(E.decidirUpload(495 * MB, 5 * MB + 1).motivo === 'cheio', '§1 1 byte além não cabe');
  ok(/não cabe: você está usando 498 MB de 500 MB/.test(E.decidirUpload(498 * MB, 5 * MB).erro), '§1 o texto diz quanto usa e o limite');
  ok(/Seu Drive está cheio \(500 MB de 500 MB\)/.test(E.decidirUpload(500 * MB, 0).erro || 'x') === false, '§1 exatamente cheio, arquivo de 0: ainda passa');
  ok(/Seu Drive está cheio/.test(E.decidirUpload(501 * MB, 0).erro), '§1 passou do limite: "está cheio"');
  ok(E.decidirUpload(0, 10 * MB + 1).motivo === 'grande', '§1 maior que 10 MB: grande');
  eq(E.decidirUpload(null, 5 * MB), { ok: true }, '⚠️ §1 sem medir o uso, deixa subir (cota é custo, não segurança)');
  eq(E.decidirUpload(100 * MB, undefined), { ok: true }, '§1 tamanho não informado conta 0');
  ok(!/column|bucket|storage|supabase/i.test(E.decidirUpload(600 * MB, 1).erro), '§1 texto sem jargão');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 2. a medição ──');
  {
    const storage = {};
    for (let i = 0; i < 1500; i++) storage[`${EU}/f${String(i).padStart(4, '0')}.txt`] = { size: 1000, created_at: velho };
    storage[`${OUTRA}/dela.pdf`] = { size: 9 * MB, created_at: velho };
    const itens = Object.keys(storage).filter((p) => p.startsWith(EU)).map((p, i) => ({ id: `i${i}`, user_id: EU, arquivo_url: p }));
    const m = mundo({ storage, tabelas: { dados_itens: itens } });
    const E2 = carregar('src/services/espacoDrive.js', { 'db/supabase': m.db });
    eq(await E2.usoDoDrive(m.db, EU), { bytes: 1500 * 1000, arquivos: 1500, limite: 500 * MB },
      '⚠️ §2 soma tudo (mais de 1000 arquivos e mais de 1000 itens: paginado), só da pasta da pessoa');
    const m2 = mundo({ storage, erroStorage: true });
    eq(await E2.usoDoDrive(m2.db, EU), null, '§2 storage fora: null (não inventa número)');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 3. as rotas ──');
  async function chamar(metodo, caminho, { params = {}, body = {}, cfg = {} }) {
    const m = mundo(cfg);
    m.tabelas.users = [{ id: EU, grupo_ativo: 'g', plano: 'premium' }];
    const router = carregar('src/routes/dados.js', { 'db/supabase': m.db, 'middlewares/auth': (rq, rs, nx) => nx() });
    const camada = router.stack.find((c) => c.route?.path === caminho && c.route?.methods?.[metodo]);
    const pilha = camada.route.stack.map((s) => s.handle);
    let status = 200, json = null;
    const req = { params, body, query: {}, authUser: { id: EU } };
    const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; } };
    let i = 0;
    const prox = async () => { const h = pilha[i++]; if (h) await h(req, res, prox); };
    await prox();
    for (let k = 0; k < 200 && json === null; k++) await new Promise((r) => setTimeout(r, 5));
    return { status, json, ...m };
  }
  const cheio = () => ({ [`${EU}/grande.zip`]: { size: 498 * MB, created_at: velho }, [`${OUTRA}/dela.pdf`]: { size: 9 * MB, created_at: velho } });
  const itensDe = (st) => Object.keys(st).filter((p) => p.startsWith(EU)).map((p, i) => ({ id: `x${i}`, user_id: EU, secao_id: 's0', arquivo_url: p }));

  let st = cheio();
  let r = await chamar('post', '/upload-url', { body: { filename: 'novo.pdf', tamanho: 5 * MB }, cfg: { storage: st, tabelas: { dados_itens: itensDe(st) } } });
  eq([r.status, r.json.codigo, r.log.assinados.length], [413, 'drive_cheio', 0], '⚠️ §3 não cabe: 413 e NENHUMA URL de upload é criada');
  ok(/498 MB de 500 MB/.test(r.json.erro), `§3 …e diz quanto usa: ${r.json.erro}`);
  st = cheio();
  r = await chamar('post', '/upload-url', { body: { filename: 'pequeno.pdf', tamanho: 1 * MB }, cfg: { storage: st, tabelas: { dados_itens: itensDe(st) } } });
  eq([r.status, r.log.assinados.length], [200, 1], '§3 cabe: cria a URL');
  ok(r.json.path.startsWith(`${EU}/`), '§3 …na pasta da pessoa');
  r = await chamar('post', '/upload-url', { body: { filename: 'x.pdf', tamanho: 11 * MB }, cfg: { storage: {} } });
  eq([r.status, r.json.codigo], [400, 'arquivo_grande'], '§3 maior que 10 MB: 400');
  st = { [`${EU}/z.zip`]: { size: 501 * MB, created_at: velho } };
  r = await chamar('post', '/upload-url', { body: { filename: 'velho-front.pdf' }, cfg: { storage: st, tabelas: { dados_itens: itensDe(st) } } });
  eq(r.status, 413, '§3 front antigo (sem tamanho) e já acima da cota: barrado mesmo assim');
  r = await chamar('post', '/upload-url', { body: { filename: 'a.pdf', tamanho: 1 * MB }, cfg: { storage: cheio(), erroStorage: true } });
  eq([r.status, r.log.assinados.length], [200, 1], '⚠️ §3 storage sem responder a medição: deixa subir');

  st = cheio();
  r = await chamar('get', '/espaco/:phone', { params: { phone: 'x' }, cfg: { storage: st, tabelas: { dados_itens: itensDe(st) } } });
  eq(r.json, { usado: 498 * MB, arquivos: 1, limite: 500 * MB }, '§3 a barra de espaço: só os arquivos da pessoa');
  r = await chamar('get', '/espaco/:phone', { params: { phone: 'x' }, cfg: { erroStorage: true } });
  eq(r.json.usado, null, '§3 sem medir: usado null (a tela não mostra número inventado)');

  // apagar PASTA leva os arquivos das subpastas
  const pasta = () => ({
    storage: {
      [`${EU}/1-a.pdf`]: { size: MB, created_at: velho }, [`${EU}/2-b.pdf`]: { size: MB, created_at: velho },
      [`${EU}/3-fica.pdf`]: { size: MB, created_at: velho }, [`${OUTRA}/dela.pdf`]: { size: MB, created_at: velho },
    },
    tabelas: {
      dados_quadros: [{ id: 'q1', user_id: EU }, { id: 'q2', user_id: EU }],
      dados_secoes: [{ id: 's1', user_id: EU, quadro_id: 'q1' }, { id: 's2', user_id: EU, quadro_id: 'q1' }, { id: 's3', user_id: EU, quadro_id: 'q2' }],
      dados_itens: [
        { id: 'i1', user_id: EU, secao_id: 's1', tipo: 'arquivo', arquivo_url: `${EU}/1-a.pdf` },
        { id: 'i2', user_id: EU, secao_id: 's2', tipo: 'arquivo', arquivo_url: `${EU}/2-b.pdf` },
        { id: 'i3', user_id: EU, secao_id: 's2', tipo: 'campo', arquivo_url: null },
        { id: 'i4', user_id: EU, secao_id: 's1', tipo: 'arquivo', arquivo_url: `${OUTRA}/dela.pdf` }, // item torto do passado
        { id: 'i5', user_id: EU, secao_id: 's3', tipo: 'arquivo', arquivo_url: `${EU}/3-fica.pdf` },
      ],
    },
  });
  r = await chamar('delete', '/dados_quadros/:id', { params: { id: 'q1' }, cfg: pasta() });
  eq([r.status, r.log.removidos.sort()], [200, [`${EU}/1-a.pdf`, `${EU}/2-b.pdf`]], '⚠️ §3 apagar a pasta apaga os arquivos dela (antes ficavam no storage pra sempre)');
  ok(r.storage[`${OUTRA}/dela.pdf`] && r.storage[`${EU}/3-fica.pdf`], '⚠️ §3 …nunca o de outra pessoa, nem o de outra pasta');
  r = await chamar('delete', '/dados_secoes/:id', { params: { id: 's2' }, cfg: pasta() });
  eq(r.log.removidos, [`${EU}/2-b.pdf`], '§3 apagar a subpasta apaga só os arquivos dela');
  r = await chamar('delete', '/dados_quadros/:id', { params: { id: 'q1' }, cfg: { ...pasta(), erroApagar: true } });
  eq([r.status, r.log.removidos.length], [500, 0], '⚠️ §3 se o banco não apagou, o arquivo fica (item nunca aponta pro nada)');
  r = await chamar('delete', '/dados_itens/:id', { params: { id: 'i4' }, cfg: pasta() });
  eq(r.log.removidos, [], '⚠️ §3 item com caminho de outra pessoa: o arquivo dela NÃO é apagado');
  r = await chamar('delete', '/dados_itens/:id', { params: { id: 'i1' }, cfg: pasta() });
  eq(r.log.removidos, [`${EU}/1-a.pdf`], '§3 apagar o item apaga o arquivo');

  r = await chamar('post', '/dados_itens', { body: { secao_id: 's1', tipo: 'arquivo', arquivo_url: `${OUTRA}/dela.pdf` }, cfg: pasta() });
  eq(r.status, 400, '⚠️ §3 criar item apontando pro arquivo de outra pessoa: 400');
  r = await chamar('post', '/dados_itens', { body: { secao_id: 's1', tipo: 'arquivo', arquivo_url: `${EU}/9-novo.pdf`, arquivo_nome: 'novo.pdf' }, cfg: pasta() });
  eq([r.status, r.json.user_id, r.json.arquivo_url], [200, EU, `${EU}/9-novo.pdf`], '§3 criar item com o próprio arquivo');
  r = await chamar('post', '/dados_itens', { body: { secao_id: 's1', tipo: 'campo', titulo: 'CPF', valor: '123' }, cfg: pasta() });
  eq([r.status, r.json.valor], [200, '123'], '§3 item sem arquivo segue igual');
  r = await chamar('put', '/dados_itens/:id', { params: { id: 'i1' }, body: { arquivo_url: `${EU}/9-novo.pdf`, arquivo_nome: 'novo.pdf' }, cfg: pasta() });
  eq([r.status, r.log.removidos], [200, [`${EU}/1-a.pdf`]], '§3 trocar o arquivo do item apaga o antigo');
  r = await chamar('put', '/dados_itens/:id', { params: { id: 'i1' }, body: { titulo: 'Só o nome' }, cfg: pasta() });
  eq([r.status, r.log.removidos], [200, []], '§3 editar sem trocar o arquivo não apaga nada');
  r = await chamar('put', '/dados_itens/:id', { params: { id: 'i1' }, body: { arquivo_url: `${OUTRA}/dela.pdf` }, cfg: pasta() });
  eq([r.status, r.log.removidos], [400, []], '⚠️ §3 editar pra apontar pro arquivo de outra pessoa: 400');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 4. o WhatsApp ──');
  {
    let baixou = 0, tamanho = MB;
    const axiosFalso = { get: async () => { baixou++; return { data: Buffer.alloc(tamanho) }; } };
    const rodar = async (storage) => {
      const m = mundo({ storage, tabelas: { dados_itens: itensDe(storage), dados_quadros: [], dados_secoes: [] } });
      const D = carregar('src/services/drive.js', { 'db/supabase': m.db, axios: axiosFalso });
      const r2 = await D.salvarArquivoDrive({ userId: EU, fileUrl: 'https://x/y', fileName: 'doc.pdf', mimeType: 'application/pdf', caption: '' });
      return { r: r2, ...m };
    };
    baixou = 0;
    let w = await rodar({ [`${EU}/z.zip`]: { size: 501 * MB, created_at: velho } });
    eq([w.r.ok, w.r.erro, baixou, w.log.uploads.length], [false, 'cheio', 0, 0], '⚠️ §4 cheio: nem baixa o arquivo');
    ok(/Seu Drive está cheio/.test(w.r.mensagem), '§4 …e devolve o texto pra pessoa');
    baixou = 0; tamanho = 3 * MB;
    w = await rodar({ [`${EU}/z.zip`]: { size: 498 * MB, created_at: velho } });
    eq([w.r.ok, w.r.erro, baixou, w.log.uploads.length], [false, 'cheio', 1, 0], '§4 baixou e não cabe: não sobe');
    tamanho = MB;
    w = await rodar({});
    eq([w.r.ok, w.log.uploads.length], [true, 1], '§4 cabe: sobe e guarda');
  }

  console.log(`\n${total} verificações · ${falhas.length ? `${falhas.length} FALHAS` : 'todas ok'}`);
  if (falhas.length) { for (const f of falhas) console.log('  ✘ ' + f); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
