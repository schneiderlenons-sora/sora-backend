// =============================================================================
// EVAL — "chegou do banco, parecido com esta conta, dar baixa?" (Sora Negócios)
// services/baixaBancoNegocio.js + rotas /conciliacao-banco e /baixa-banco.
//
// Errar pra MAIS quita a conta errada (o cliente que ainda deve some da lista
// de cobrança). Errar pra MENOS deixa a projeção dobrada, que é o relato.
//
// Rodar: npm run eval:baixa-banco-negocio
// =============================================================================
const path = require('path');
const { sugestoesBaixaBanco, patchDaBaixa } = require('../src/services/baixaBancoNegocio');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

const A = (id, venc, valor, extra = {}) => ({
  id, empresa_id: 'e1', tipo: 'entrada', status: 'pendente', valor, vencimento: venc, data: venc,
  transacao_id: null, origem: 'manual', categoria: 'servico', descricao: 'Contrato', ...extra,
});
const B = (id, data, valor, extra = {}) => ({
  id, empresa_id: 'e1', tipo: 'entrada', status: 'pago', valor, data, transacao_id: `t-${id}`,
  origem: 'banco', categoria: 'a_classificar', descricao: 'PIX RECEBIDO', conta_id: 'c1', ...extra,
});
const pares = (s) => s.map((x) => `${x.aberto.id}=${x.banco.id}`).sort();
const rodar = (ls) => sugestoesBaixaBanco({ lancamentos: ls });

console.log('§1 desconto, juros e atraso');
{
  eq(pares(rodar([A('a', '2026-10-23', 150000), B('b', '2026-10-24', 145000)])), ['a=b'], '§1 desconto de 3,3%');
  eq(pares(rodar([A('a', '2026-10-23', 150000), B('b', '2026-11-05', 153000)])), ['a=b'], '§1 atraso de 13 dias com juros');
  eq(pares(rodar([A('a', '2026-10-01', 150000), B('b', '2026-10-10', 150000)])), ['a=b'], '§1 valor exato mas 9 dias depois (fora da baixa automática)');
  eq(rodar([A('a', '2026-10-23', 150000), B('b', '2026-10-24', 165000)]).length, 1, '§1 exatamente 10% entra');
  eq(rodar([A('a', '2026-10-23', 150000), B('b', '2026-10-24', 165100)]).length, 0, '§1 acima de 10% fica fora');
  eq(rodar([A('a', '2026-10-23', 500), B('b', '2026-10-24', 600)]).length, 1, '§1 conta pequena: tolerância mínima de R$ 1');
  eq(rodar([A('a', '2026-10-23', 500), B('b', '2026-10-24', 601)]).length, 0, '§1 e não mais que R$ 1');
}
console.log('  ok');

console.log('§2 janela');
{
  eq(rodar([A('a', '2026-10-23', 150000), B('b', '2026-10-17', 150000)]).length, 1, '§2 6 dias antes entra');
  eq(rodar([A('a', '2026-10-23', 150000), B('b', '2026-10-16', 150000)]).length, 0, '§2 7 dias antes fica fora');
  eq(rodar([A('a', '2026-10-23', 150000), B('b', '2026-11-12', 150000)]).length, 1, '§2 20 dias depois entra');
  eq(rodar([A('a', '2026-10-23', 150000), B('b', '2026-11-13', 150000)]).length, 0, '§2 21 dias depois fica fora');
  eq(rodar([A('a', null, 150000, { data: '2026-10-23' }), B('b', '2026-10-24', 150000)]).length, 1, '§2 sem vencimento usa a data');
}
console.log('  ok');

console.log('§3 o que nunca casa');
{
  eq(rodar([A('a', '2026-10-23', 150000), B('b', '2026-10-24', 150000, { tipo: 'saida' })]).length, 0, '§3 sentidos diferentes');
  eq(rodar([A('a', '2026-10-23', 150000), B('b', '2026-10-24', 150000, { categoria: 'movimentacao' })]).length, 0, '§3 movimentação entre contas');
  eq(rodar([A('a', '2026-10-23', 150000), B('b', '2026-10-24', 150000, { status: 'pendente' })]).length, 0, '§3 do banco ainda pendente');
  eq(rodar([A('a', '2026-10-23', 150000), B('b', '2026-10-24', 150000, { origem: 'manual' })]).length, 0, '§3 digitado não é "do banco"');
  eq(rodar([A('a', '2026-10-23', 150000, { transacao_id: 't9' }), B('b', '2026-10-24', 150000)]).length, 0, '§3 conta já ligada ao banco');
  eq(rodar([A('a', '2026-10-23', 150000, { status: 'pago' }), B('b', '2026-10-24', 150000)]).length, 0, '§3 conta já paga');
  eq(rodar([A('a', '2026-10-23', 0), B('b', '2026-10-24', 50)]).length, 0, '§3 conta sem valor');
  // Lançamento do banco que perdeu o vínculo (reprocesso do agregador) não é "conta a receber".
  eq(rodar([A('a', '2026-10-23', 150000, { origem: 'banco' }), B('b', '2026-10-24', 150000)]).length, 0, '§3 solto do banco não é conta em aberto');
}
console.log('  ok');

console.log('§4 disputa e semanal de mesmo valor (o caso de origem)');
{
  // Contrato semanal: duas semanas de R$ 1.500 em aberto, dois Pix com desconto.
  const s = rodar([
    A('s16', '2026-10-16', 150000), A('s23', '2026-10-23', 150000),
    B('p17', '2026-10-17', 145000), B('p24', '2026-10-24', 145000),
  ]);
  eq(pares(s), ['s16=p17', 's23=p24'], '§4 cada Pix vai pra SUA semana (a data desempata)');
  // Duas contas quase iguais, à mesma distância: nenhuma.
  eq(rodar([A('x', '2026-10-23', 150000), A('y', '2026-10-23', 150500), B('b', '2026-10-24', 145000)]).length, 0,
    '§4 empate de verdade: nenhuma sugestão');
  // Uma bem mais parecida: vai pra ela.
  eq(pares(rodar([A('x', '2026-10-23', 150000), A('y', '2026-10-23', 160000), B('b', '2026-10-24', 145000)])), ['x=b'],
    '§4 a mais parecida leva');
}
console.log('  ok');

console.log('§5 o que a baixa grava');
{
  const p = patchDaBaixa(A('a', '2026-10-23', 150000, { categoria: null, observacao: null }),
    B('b', '2026-10-24', 145000, { categoria: 'servico' }));
  eq(p.transacao_id, 't-b', '§5 herda o vínculo com o banco');
  eq(p.status, 'pago', '§5 fica paga');
  eq(p.pago_em, '2026-10-24', '§5 na data do banco');
  eq(p.valor, 145000, '§5 com o valor do banco');
  eq(p.conta_id, 'c1', '§5 na conta do banco');
  eq(p.categoria, 'servico', '§5 sem categoria, herda a que a pessoa deu ao do banco');
  ok(/previsto R\$\s?1\.500,00.*recebido R\$\s?1\.450,00/.test(p.observacao || ''), `§5 anota a diferença (${p.observacao})`);
  ok(!('data' in p) && !('descricao' in p) && !('contraparte' in p), '§5 não mexe na competência, descrição nem cliente');
  const igual = patchDaBaixa(A('a', '2026-10-01', 150000), B('b', '2026-10-10', 150000));
  ok(!('observacao' in igual), '§5 valor igual: sem nota');
  ok(!('categoria' in igual), '§5 a categoria da conta fica');
  const naoClass = patchDaBaixa(A('a', '2026-10-01', 150000, { categoria: null }), B('b', '2026-10-10', 150000));
  ok(!('categoria' in naoClass), '§5 "a classificar" do banco não vira categoria');
}
console.log('  ok');

// ── Rotas reais, banco falso ────────────────────────────────────────────────
function criarBanco(inicial) {
  const tabelas = JSON.parse(JSON.stringify(inicial));
  function from(nome) {
    const filtros = [];
    let modo = 'select', payload = null, unica = null;
    const api = {
      select() { return api; }, order() { return api; }, limit() { return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      delete() { modo = 'delete'; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      is(c, v) { filtros.push((r) => (r[c] ?? null) === v); return api; },
      gte(c, v) { filtros.push((r) => r[c] != null && String(r[c]) >= String(v)); return api; },
      lte(c, v) { filtros.push((r) => r[c] != null && String(r[c]) <= String(v)); return api; },
      maybeSingle() { unica = 'm'; return api; },
      then(res, rej) { return Promise.resolve().then(exec).then(res, rej); },
    };
    function exec() {
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
  return { listar: chamar('get', '/conciliacao-banco/:phone'), baixar: chamar('post', '/lancamentos/:id/baixa-banco') };
}

const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
const diaRel = (n) => new Date(Date.parse(hoje + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const cenario = () => ({
  users: [{ id: 'u1', grupo_ativo: 'g1', plano: 'platinum' }],
  lancamentos_negocio: [
    A('a', diaRel(-5), 150000),
    B('b', diaRel(-3), 145000),
    A('outra', diaRel(-5), 90000, { empresa_id: 'e2' }),
    B('bout', diaRel(-3), 90000, { empresa_id: 'e2' }),
  ],
});

(async () => {
  console.log('§6 rotas');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    const l = await r.listar({ query: { empresa_id: 'e1' } });
    eq(l.statusCode, 200, '§6 listar responde 200');
    eq(l.body.sugestoes.map((s) => `${s.aberto.id}=${s.banco.id}`), ['a=b'], '§6 só a da empresa pedida');

    const ok1 = await r.baixar({ params: { id: 'a' }, body: { banco_id: 'b' } });
    eq(ok1.statusCode, 200, '§6 baixa responde 200');
    const a = b.tabelas.lancamentos_negocio.find((x) => x.id === 'a');
    eq([a.status, a.valor, a.transacao_id], ['pago', 145000, 't-b'], '§6 a conta fica paga, com o valor e o vínculo do banco');
    ok(!b.tabelas.lancamentos_negocio.some((x) => x.id === 'b'), '§6 o lançamento solto do banco sai (não conta duas vezes)');

    const de2 = await r.baixar({ params: { id: 'a' }, body: { banco_id: 'b' } });
    ok(de2.statusCode === 404 || de2.statusCode === 409, '§6 repetir a baixa não faz nada');
    // Conta já paga + OUTRO lançamento do banco válido: recusa e não apaga nada.
    b.tabelas.lancamentos_negocio.push(B('b2', diaRel(-2), 145000));
    const paga = await r.baixar({ params: { id: 'a' }, body: { banco_id: 'b2' } });
    eq(paga.statusCode, 409, '§6 conta já paga: 409');
    ok(b.tabelas.lancamentos_negocio.some((x) => x.id === 'b2'), '§6 e o lançamento do banco fica');
  }
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    const outra = await r.baixar({ params: { id: 'outra' }, body: { banco_id: 'bout' } });
    eq(outra.statusCode, 404, '§6 empresa que a pessoa não alcança: 404');
    const cruz = await r.baixar({ params: { id: 'a' }, body: { banco_id: 'a' } });
    eq(cruz.statusCode, 409, '§6 "banco" que não é do banco: 409');
    b.tabelas.lancamentos_negocio.find((x) => x.id === 'b').tipo = 'saida';
    eq((await r.baixar({ params: { id: 'a' }, body: { banco_id: 'b' } })).statusCode, 400, '§6 sentidos diferentes: 400');
    ok(b.tabelas.lancamentos_negocio.some((x) => x.id === 'b'), '§6 recusada, nada é apagado');
  }
  console.log('  ok');

  if (falhas.length) {
    console.error(`\n✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('\n✓ baixa pelo banco (Negócios): todos os casos passaram');
})().catch((e) => { console.error('✗ eval quebrou:', e); process.exit(1); });
