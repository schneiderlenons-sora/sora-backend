// =============================================================================
// EVAL DE ROTA — tela "Regras aprendidas" do Sora Negócios (migration 192).
//
// Ver, trocar a categoria e apagar. O que não pode acontecer: mexer em regra de
// OUTRA empresa, trocar a categoria passando por cima da escolha da pessoa, e
// apagar a regra "desclassificando" o que ela já classificou.
//
// Rodar: npm run eval:regras-negocio-rota
// =============================================================================
const path = require('path');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

function criarBanco(inicial, { semTabela = false } = {}) {
  const tabelas = JSON.parse(JSON.stringify(inicial));
  function from(nome) {
    const filtros = [];
    let modo = 'select', payload = null, unica = null;
    const api = {
      select() { return api; }, order() { return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      delete() { modo = 'delete'; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      in(c, vs) { filtros.push((r) => vs.includes(r[c])); return api; },
      maybeSingle() { unica = 'm'; return api; },
      then(res, rej) { return Promise.resolve().then(exec).then(res, rej); },
    };
    function exec() {
      if (semTabela && nome === 'regras_negocio') return { data: null, error: { message: 'relation "regras_negocio" does not exist' } };
      const t = tabelas[nome] || (tabelas[nome] = []);
      const alvo = t.filter((r) => filtros.every((f) => f(r)));
      if (modo === 'update') alvo.forEach((r) => Object.assign(r, payload));
      if (modo === 'delete') tabelas[nome] = t.filter((r) => !alvo.includes(r));
      const l = alvo.map((r) => ({ ...r }));
      return unica === 'm' ? { data: l[0] || null, error: null } : { data: l, error: null };
    }
    return api;
  }
  return { tabelas, client: { from } };
}

function carregar(banco) {
  const raiz = path.join(__dirname, '..', 'src') + path.sep;
  const fixar = (rel, ex) => { const f = path.join(raiz, rel); require.cache[f] = { id: f, filename: f, loaded: true, exports: ex }; };
  for (const k of Object.keys(require.cache)) if (k.startsWith(raiz)) delete require.cache[k];
  fixar('db/supabase.js', banco.client);
  fixar('middlewares/auth.js', (q, s, n) => n());
  fixar('config/planos.js', { temNegocios: () => true });
  fixar('handlers/negocios.js', { gerarDre: async () => ({}), sugerirConciliacao: async () => [] });
  fixar('handlers/insights-negocio.js', { gerarInsights: async () => [] });
  fixar('services/cripto.js', { encrypt: (x) => x, decrypt: (x) => x });
  fixar('services/hotmart-import.js', { importarHistoricoHotmart: async () => ({}) });
  fixar('services/acessoEmpresa.js', {
    podeNaEmpresa: async (u, e) => e === 'e1', empresasDoUsuario: async () => [], empresaAssumida: () => null,
    papelPermite: () => true, papelNaEmpresa: async () => 'admin', PAPEIS: [],
  });
  const router = require(path.join(raiz, 'routes/negocios.js'));
  const h = (m, r) => { const l = router.stack.find((x) => x.route && x.route.path === r && x.route.methods[m]); return l.route.stack[l.route.stack.length - 1].handle; };
  const chamar = (m, r) => async (req = {}) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await h(m, r)({ params: {}, query: {}, body: {}, authUser: { id: 'u1' }, ...req }, res);
    return res;
  };
  return { listar: chamar('get', '/regras/:phone'), editar: chamar('put', '/regras/:id'), apagar: chamar('delete', '/regras/:id') };
}

const cenario = () => ({
  users: [{ id: 'u1', grupo_ativo: 'g1', plano: 'platinum' }],
  regras_negocio: [
    { id: 'r1', empresa_id: 'e1', termo: 'joao silva', tipo: 'entrada', categoria: 'servicos', created_at: '2026-10-30' },
    { id: 'r2', empresa_id: 'e2', termo: 'acme', tipo: 'saida', categoria: 'fornecedor', created_at: '2026-10-30' },
  ],
  lancamentos_negocio: [
    { id: 'l1', empresa_id: 'e1', tipo: 'entrada', descricao: 'PIX RECEBIDO JOAO DA SILVA', categoria: 'servicos' },
    { id: 'l2', empresa_id: 'e1', tipo: 'entrada', descricao: 'PIX RECEBIDO JOAO DA SILVA', categoria: 'a_classificar' },
    { id: 'l3', empresa_id: 'e1', tipo: 'entrada', descricao: 'PIX RECEBIDO JOAO DA SILVA', categoria: 'outros' },
  ],
});
const cat = (b, id) => b.tabelas.lancamentos_negocio.find((l) => l.id === id).categoria;

(async () => {
  console.log('§1 listar');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    const l = await r.listar({ query: { empresa_id: 'e1' } });
    eq(l.body.regras.map((x) => x.id), ['r1'], '§1 só as da empresa pedida');
    const sem = carregar(criarBanco(cenario(), { semTabela: true }));
    const s = await sem.listar({ query: { empresa_id: 'e1' } });
    eq([s.statusCode, s.body.regras.length, s.body.semMigration], [200, 0, true], '§1 sem a 192: lista vazia e diz por quê');
  }
  console.log('  ok');

  console.log('§2 trocar a categoria');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    const e = await r.editar({ params: { id: 'r1' }, body: { categoria: 'vendas' } });
    eq(e.statusCode, 200, '§2 responde 200');
    eq(b.tabelas.regras_negocio.find((x) => x.id === 'r1').categoria, 'vendas', '§2 a regra muda');
    eq(cat(b, 'l2'), 'vendas', '§2 o "a classificar" que casa é acertado');
    eq(cat(b, 'l3'), 'outros', '§2 a escolha da pessoa fica');
    eq(cat(b, 'l1'), 'servicos', '§2 o que a regra antiga classificou não é reescrito');
    eq(e.body.aplicadas, 1, '§2 conta só o acertado');
    eq((await r.editar({ params: { id: 'r1' }, body: { categoria: '' } })).statusCode, 400, '§2 sem categoria: 400');
    eq((await r.editar({ params: { id: 'r1' }, body: { categoria: 'a_classificar' } })).statusCode, 400, '§2 "a classificar" não é categoria');
    eq((await r.editar({ params: { id: 'r2' }, body: { categoria: 'x' } })).statusCode, 404, '§2 regra de outra empresa: 404');
    eq(b.tabelas.regras_negocio.find((x) => x.id === 'r2').categoria, 'fornecedor', '§2 e ela não muda');
  }
  console.log('  ok');

  console.log('§3 apagar');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    eq((await r.apagar({ params: { id: 'r2' } })).statusCode, 404, '§3 regra de outra empresa: 404');
    ok(b.tabelas.regras_negocio.some((x) => x.id === 'r2'), '§3 e ela fica');
    eq((await r.apagar({ params: { id: 'r1' } })).statusCode, 200, '§3 apaga a da empresa');
    ok(!b.tabelas.regras_negocio.some((x) => x.id === 'r1'), '§3 a regra sai');
    eq(cat(b, 'l1'), 'servicos', '§3 o que ela já classificou continua classificado');
  }
  console.log('  ok');

  if (falhas.length) {
    console.error(`\n✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('\n✓ regras aprendidas (rota): todos os casos passaram');
})().catch((e) => { console.error('✗ eval quebrou:', e); process.exit(1); });
