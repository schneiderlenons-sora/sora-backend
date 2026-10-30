// =============================================================================
// EVAL DE ROTA — contas que se repetem no Sora Negócios (migration 192).
//
// Roda as rotas REAIS de lançamento com um banco falso em memória:
//   · criar com repetição gera as próximas na hora;
//   · "aplicar também às próximas" só mexe nas futuras em aberto e digitadas;
//   · "parar de repetir" apaga só as futuras em aberto e o job não regera;
//   · o centro de custo, antes descartado em silêncio, passa a gravar.
//
// Rodar: npm run eval:serie-negocio-rota
// =============================================================================
const path = require('path');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

function criarBanco(inicial, { semMigration = false } = {}) {
  const tabelas = JSON.parse(JSON.stringify(inicial));
  let seq = 0;
  function from(nome) {
    const filtros = [];
    let modo = 'select', payload = null, unica = null, devolve = false;
    const api = {
      select() { devolve = true; return api; },
      insert(p) { modo = 'insert'; payload = p; return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      delete() { modo = 'delete'; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      is(c, v) { filtros.push((r) => (r[c] ?? null) === v); return api; },
      gt(c, v) { filtros.push((r) => r[c] != null && String(r[c]) > String(v)); return api; },
      not(c, op, v) { filtros.push((r) => !((r[c] ?? null) === v)); return api; },
      order() { return api; }, limit() { return api; },
      range(a, b) { api._range = [a, b]; return api; },
      single() { unica = 's'; return api; },
      maybeSingle() { unica = 'm'; return api; },
      then(res, rej) { return Promise.resolve().then(exec).then(res, rej); },
    };
    function exec() {
      const t = tabelas[nome] || (tabelas[nome] = []);
      if (modo === 'insert') {
        const lista = Array.isArray(payload) ? payload : [payload];
        if (semMigration && lista.some((p) => 'serie_id' in p)) {
          return { data: null, error: { message: 'column "serie_id" of relation "lancamentos_negocio" does not exist' } };
        }
        const novas = lista.map((p) => ({ id: `x${++seq}`, transacao_id: null, ...p }));
        t.push(...novas);
        return unica ? { data: novas[0], error: null } : { data: novas, error: null };
      }
      const alvo = t.filter((r) => filtros.every((f) => f(r)));
      if (modo === 'update') alvo.forEach((r) => Object.assign(r, payload));
      if (modo === 'delete') tabelas[nome] = t.filter((r) => !alvo.includes(r));
      let l = alvo.map((r) => ({ ...r }));
      if (api._range) l = l.slice(api._range[0], api._range[1] + 1);
      if (unica === 's') return l.length === 1 ? { data: l[0], error: null } : { data: null, error: { message: 'single' } };
      if (unica === 'm') return { data: l[0] || null, error: null };
      return { data: devolve || modo === 'select' ? l : null, error: null };
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
  const h = (metodo, rota) => {
    const l = router.stack.find((x) => x.route && x.route.path === rota && x.route.methods[metodo]);
    if (!l) throw new Error(`rota: ${metodo} ${rota}`);
    return l.route.stack[l.route.stack.length - 1].handle;
  };
  const chamar = (metodo, rota) => async (req = {}) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await h(metodo, rota)({ params: {}, query: {}, body: {}, authUser: { id: 'u1' }, ...req }, res);
    return res;
  };
  return {
    criar: chamar('post', '/lancamentos'),
    editar: chamar('put', '/lancamentos/:id'),
    parar: chamar('post', '/lancamentos/:id/parar-serie'),
    serie: require(path.join(raiz, 'services/serieNegocio.js')),
  };
}

const base = () => ({
  users: [{ id: 'u1', grupo_ativo: 'g1', plano: 'platinum' }],
  empresas: [{ id: 'e1', user_id: 'u1', grupo_id: 'g1' }],
  centros_custo: [{ id: 'cc1', empresa_id: 'e1' }, { id: 'cc-outra', empresa_id: 'e2' }],
  lancamentos_negocio: [],
});
const hojeSP = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const semana = (n) => { const d = new Date(`${hojeSP()}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 7 * n); return d.toISOString().slice(0, 10); };
const contrato = (extra = {}) => ({
  empresa_id: 'e1', tipo: 'entrada', descricao: 'Contrato semanal', valor: 150000, data: hojeSP(),
  status: 'pendente', vencimento: hojeSP(), contraparte: 'Cliente X', recorrencia: 'semanal', ...extra,
});

(async () => {
  console.log('§1 criar com repetição gera as próximas');
  {
    const b = criarBanco(base()); const r = carregar(b);
    const res = await r.criar({ body: contrato() });
    eq(res.statusCode, 200, '§1 responde 200');
    eq(res.body.gerados, 13, '§1 gera 13 semanas na hora');
    const linhas = b.tabelas.lancamentos_negocio;
    eq(linhas.length, 14, '§1 a primeira + 13');
    ok(linhas.every((l) => l.serie_id && l.serie_id === linhas[0].serie_id), '§1 todas na mesma série');
    ok(linhas.every((l) => l.status === 'pendente' && l.recorrente === true), '§1 todas em aberto e marcadas');
  }
  console.log('  ok');

  console.log('§2 repetição inválida e fim antes do começo');
  {
    const b = criarBanco(base()); const r = carregar(b);
    eq((await r.criar({ body: contrato({ recorrencia: 'diaria' }) })).statusCode, 400, '§2 recorrência desconhecida: 400');
    eq((await r.criar({ body: contrato({ serie_ate: '2020-01-01' }) })).statusCode, 400, '§2 fim antes da 1ª: 400');
    eq(b.tabelas.lancamentos_negocio.length, 0, '§2 nada gravado');
  }
  console.log('  ok');

  console.log('§3 sem repetição: igual a antes (e sem a 192 também)');
  {
    const b = criarBanco(base(), { semMigration: true }); const r = carregar(b);
    const res = await r.criar({ body: contrato({ recorrencia: undefined }) });
    eq(res.statusCode, 200, '§3 lançamento comum grava sem a 192');
    ok(!('serie_id' in b.tabelas.lancamentos_negocio[0]), '§3 não manda campos de série');
    const rep = await r.criar({ body: contrato() });
    eq(rep.statusCode, 503, '§3 pedir repetição sem a 192 avisa (503), não finge que salvou');
  }
  console.log('  ok');

  console.log('§4 aplicar às próximas');
  {
    const b = criarBanco(base()); const r = carregar(b);
    await r.criar({ body: contrato() });
    const ls = b.tabelas.lancamentos_negocio;
    // A 3ª semana já foi paga; a 5ª veio do banco.
    const terc = ls.find((l) => l.vencimento === semana(3)); terc.status = 'pago';
    const quinta = ls.find((l) => l.vencimento === semana(5)); quinta.transacao_id = 't-banco';
    const segunda = ls.find((l) => l.vencimento === semana(1));
    const res = await r.editar({ params: { id: segunda.id }, body: { valor: 175000, aplicar_serie: true } });
    eq(res.statusCode, 200, '§4 responde 200');
    eq(segunda.valor, 175000, '§4 a editada muda');
    eq(ls.find((l) => l.vencimento === semana(0)).valor, 150000, '§4 a ANTERIOR não muda');
    eq(terc.valor, 150000, '§4 a já paga não muda');
    eq(quinta.valor, 150000, '§4 a que veio do banco não muda');
    eq(ls.find((l) => l.vencimento === semana(4)).valor, 175000, '§4 a próxima em aberto muda');
    eq(res.body.aplicadas, 10, '§4 conta só as futuras em aberto e digitadas (13 − 1 − paga − banco)');
    // Sem pedir, só a editada muda.
    const res2 = await r.editar({ params: { id: segunda.id }, body: { descricao: 'Contrato' } });
    eq(res2.body.aplicadas, 0, '§4 sem "aplicar", nada além dela');
  }
  console.log('  ok');

  console.log('§5 parar de repetir');
  {
    const b = criarBanco(base()); const r = carregar(b);
    await r.criar({ body: contrato() });
    const ls = () => b.tabelas.lancamentos_negocio;
    const paga = ls().find((l) => l.vencimento === semana(6)); paga.status = 'pago';
    const alvo = ls().find((l) => l.vencimento === semana(2));
    const res = await r.parar({ params: { id: alvo.id } });
    eq(res.statusCode, 200, '§5 responde 200');
    eq(res.body.removidas, 10, '§5 apaga as futuras em aberto (11 − a paga)');
    ok(ls().some((l) => l.id === alvo.id), '§5 a própria fica');
    ok(ls().some((l) => l.id === paga.id), '§5 a já paga fica');
    ok(ls().every((l) => l.recorrente === false), '§5 a série inteira fica parada');
    // O job do dia seguinte não regera nada.
    const job = await r.serie.estenderSeries({ supabase: b.client });
    eq(job.criadas, 0, '§5 o job não regera série parada');
    eq((await r.parar({ params: { id: 'nao-existe' } })).statusCode, 404, '§5 id inexistente: 404');
    const solta = (await r.criar({ body: contrato({ recorrencia: undefined }) })).body.lancamento;
    eq((await r.parar({ params: { id: solta.id } })).statusCode, 400, '§5 lançamento que não se repete: 400');
  }
  console.log('  ok');

  console.log('§6 o job completa uma série que ficou curta');
  {
    const b = criarBanco(base()); const r = carregar(b);
    await r.criar({ body: contrato() });
    // Simula que só a 1ª foi gravada (a geração falhou na hora).
    const sid = b.tabelas.lancamentos_negocio[0].serie_id;
    b.tabelas.lancamentos_negocio = b.tabelas.lancamentos_negocio.slice(0, 1);
    const job = await r.serie.estenderSeries({ supabase: b.client });
    eq(job.criadas, 13, '§6 o job gera o que faltou');
    ok(b.tabelas.lancamentos_negocio.every((l) => l.serie_id === sid), '§6 na mesma série');
  }
  console.log('  ok');

  console.log('§7 centro de custo grava (era descartado)');
  {
    const b = criarBanco(base()); const r = carregar(b);
    const c1 = await r.criar({ body: contrato({ recorrencia: undefined, centro_custo_id: 'cc1' }) });
    eq(c1.body.lancamento.centro_custo_id, 'cc1', '§7 POST grava o centro da empresa');
    const c2 = await r.criar({ body: contrato({ recorrencia: undefined, centro_custo_id: 'cc-outra' }) });
    ok(!c2.body.lancamento.centro_custo_id, '§7 centro de OUTRA empresa é ignorado');
    await r.editar({ params: { id: c2.body.lancamento.id }, body: { centro_custo_id: 'cc1' } });
    eq(b.tabelas.lancamentos_negocio.find((l) => l.id === c2.body.lancamento.id).centro_custo_id, 'cc1', '§7 PUT grava');
    await r.editar({ params: { id: c2.body.lancamento.id }, body: { centro_custo_id: null } });
    eq(b.tabelas.lancamentos_negocio.find((l) => l.id === c2.body.lancamento.id).centro_custo_id, null, '§7 PUT tira');
  }
  console.log('  ok');

  if (falhas.length) {
    console.error(`\n✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('\n✓ contas que se repetem (rota): todos os casos passaram');
})().catch((e) => { console.error('✗ eval quebrou:', e); process.exit(1); });
