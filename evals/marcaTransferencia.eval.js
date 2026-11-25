// =============================================================================
// EVAL: marcar / desmarcar "transferência entre minhas contas" na edição.
//
// Relato (Breno, nov/2026): o pagamento do financiamento (TED pro Itaú) veio do
// banco como "transferência entre contas" e ficou fora dos gastos — ele trocou
// a categoria pra "Financiamento", mas a marca continuou, e a tela não tinha
// como tirá-la. O que este eval trava:
//   1. a regra pura (services/marcaTransferencia.js): só linha do banco, nunca
//      cartão, nunca pagamento de fatura/ajuste, e tirar a marca exige sair da
//      categoria "Transferências";
//   2. a ROTA REAL (PUT /api/transacoes/:id, banco falso):
//      · tirar a marca do financiamento faz ele voltar a contar como gasto;
//      · ⚠️ NENHUM SALDO SE MEXE (nem na conta do banco, nem numa manual);
//      · ⚠️ quem NÃO pede a troca (ou manda o mesmo valor) edita como antes —
//        inclusive numa linha de cartão marcada, que a regra recusaria;
//      · recusa → nada é gravado (nem a categoria que veio junto).
//
// Rodar:  npm run eval:marca-transferencia
// =============================================================================
const path = require('path');

const falhas = [];
let total = 0;
const ok = (cond, m) => { total++; if (!cond) falhas.push(m); };

// ── 1. regra pura ────────────────────────────────────────────────────────────
console.log('── 1. regra pura ──');
const { validarMarcaTransferencia: v } = require('../src/services/marcaTransferencia');
const BANCO = { of_tx_id: 'OF1', categoria: 'Financiamento', transferencia: true };
const CONTA = { tipo: 'Corrente' };
ok(v({ antes: BANCO, carteira: CONTA, transferencia: false, categoriaFinal: 'Financiamento' }).ok, 'linha do banco, conta corrente: pode tirar a marca');
ok(v({ antes: { ...BANCO, transferencia: false, categoria: 'Pix enviado' }, carteira: CONTA, transferencia: true, categoriaFinal: 'Pix enviado' }).ok, 'pode pôr a marca (Pix pra si mesmo)');
ok(v({ antes: BANCO, carteira: { tipo: 'Poupança' }, transferencia: false, categoriaFinal: 'Financiamento' }).ok, 'poupança também');
ok(v({ antes: BANCO, carteira: null, transferencia: false, categoriaFinal: 'Financiamento' }).ok, 'carteira não achada não é cartão');
const r1 = v({ antes: { ...BANCO, of_tx_id: null }, carteira: CONTA, transferencia: false, categoriaFinal: 'Financiamento' });
ok(!r1.ok && r1.status === 409, '⚠️ lançamento MANUAL não pode (a marca decide o saldo dele)');
const r2 = v({ antes: BANCO, carteira: { tipo: 'Crédito' }, transferencia: false, categoriaFinal: 'Financiamento' });
ok(!r2.ok && r2.status === 409, '⚠️ CARTÃO não pode (mexeria no valor da fatura)');
ok(!v({ antes: BANCO, carteira: { tipo: 'Cartão de crédito' }, transferencia: true, categoriaFinal: 'X' }).ok, 'cartão escrito por extenso também não');
const r3 = v({ antes: { ...BANCO, categoria: 'Fatura' }, carteira: CONTA, transferencia: false, categoriaFinal: 'Fatura' });
ok(!r3.ok && r3.status === 409, '⚠️ pagamento de fatura não pode (somaria o cartão em dobro)');
ok(!v({ antes: BANCO, carteira: CONTA, transferencia: false, categoriaFinal: 'Fatura' }).ok, 'nem mudando a categoria pra Fatura');
ok(!v({ antes: { ...BANCO, categoria: 'Cartão de Credito' }, carteira: CONTA, transferencia: false, categoriaFinal: 'Cartão de Credito' }).ok, 'nem a fatura legada');
ok(!v({ antes: { ...BANCO, categoria: 'Ajuste' }, carteira: CONTA, transferencia: false, categoriaFinal: 'Ajuste' }).ok, 'ajuste de saldo não');
const r4 = v({ antes: { ...BANCO, categoria: 'Transferências' }, carteira: CONTA, transferencia: false, categoriaFinal: 'Transferências' });
ok(!r4.ok && r4.status === 400, '⚠️ tirar a marca mantendo "Transferências" pede a categoria (senão nada mudaria)');
ok(v({ antes: { ...BANCO, categoria: 'Transferências' }, carteira: CONTA, transferencia: false, categoriaFinal: 'Financiamento' }).ok, 'trocando a categoria junto, pode');
ok(v({ antes: { ...BANCO, categoria: 'Transferências', transferencia: false }, carteira: CONTA, transferencia: true, categoriaFinal: 'Transferências' }).ok, 'pôr a marca com "Transferências" pode');
ok(!v({ antes: BANCO, carteira: CONTA, transferencia: 'false', categoriaFinal: 'X' }).ok, 'texto "false" não é boolean');
ok(!v({ antes: BANCO, carteira: CONTA, transferencia: 0, categoriaFinal: 'X' }).ok, '0 não é boolean');
ok(!v({ antes: null, carteira: CONTA, transferencia: false, categoriaFinal: 'X' }).ok, 'sem a linha não pode');

// ── 2. a rota real com banco falso ───────────────────────────────────────────
console.log('── 2. rota real (PUT /api/transacoes/:id) ──');
function criarBanco(inicial) {
  const tabelas = JSON.parse(JSON.stringify(inicial));
  function from(nome) {
    const filtros = []; let modo = 'select', payload = null, retornar = false, unica = null;
    const api = {
      select() { if (modo !== 'select') retornar = true; return api; },
      insert(p) { modo = 'insert'; payload = p; return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      upsert() { modo = 'upsert'; return api; },
      delete() { modo = 'delete'; return api; },
      eq(c, val) { filtros.push((r) => r[c] === val); return api; },
      ilike(c, val) { filtros.push((r) => String(r[c] ?? '').toLowerCase() === String(val ?? '').toLowerCase()); return api; },
      is(c, val) { filtros.push((r) => (r[c] ?? null) === val); return api; },
      in(c, arr) { const s = new Set(arr); filtros.push((r) => s.has(r[c])); return api; },
      order() { return api; }, limit() { return api; },
      single() { unica = 'single'; return api; }, maybeSingle() { unica = 'maybe'; return api; },
      then(res, rej) { return Promise.resolve().then(executar).then(res, rej); },
    };
    const responder = (l) => (unica === 'single' ? (l.length === 1 ? { data: { ...l[0] }, error: null } : { data: null, error: { message: 'single' } })
      : unica === 'maybe' ? { data: l[0] ? { ...l[0] } : null, error: null } : { data: l.map((r) => ({ ...r })), error: null });
    function executar() {
      const t = tabelas[nome] || (tabelas[nome] = []);
      if (modo === 'insert' || modo === 'upsert' || modo === 'delete') return { data: null, error: null };
      const alvo = t.filter((r) => filtros.every((f) => f(r)));
      if (modo === 'update') { alvo.forEach((r) => Object.assign(r, payload)); return retornar || unica ? responder(alvo) : { data: null, error: null }; }
      return responder(alvo);
    }
    return api;
  }
  return { client: { from }, tabelas };
}
function carregarRota(banco) {
  const raiz = path.resolve(__dirname, '../src');
  const fixar = (rel, exports) => { const f = path.join(raiz, rel); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
  for (const k of Object.keys(require.cache)) if (k.startsWith(raiz)) delete require.cache[k];
  fixar('db/supabase.js', banco.client);
  fixar('middlewares/auth.js', (req, res, next) => next());
  fixar('middlewares/permissao.js', { exigirPermissao: () => (req, res, next) => next() });
  const router = require(path.join(raiz, 'routes/transacoes.js'));
  const layer = router.stack.find((l) => l.route && l.route.path === '/:id' && l.route.methods.put);
  const h = layer.route.stack[layer.route.stack.length - 1].handle;
  return async (id, body) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await h({ params: { id }, query: {}, body, authUser: { id: 'u1' }, grupoId: 'g1', userId: 'u1' }, res);
    return res;
  };
}
const CENARIO = {
  wallets: [
    { id: 'w1', grupo_id: 'g1', nome: 'Bradesco Pessoa Física', tipo: 'Corrente', saldo: 5, of_conta_id: 'acc1' },
    { id: 'w2', grupo_id: 'g1', nome: 'Mercado Pago Crédito', tipo: 'Crédito', saldo: -1834.12, of_conta_id: 'acc2' },
    { id: 'w3', grupo_id: 'g1', nome: 'Carteira', tipo: 'Dinheiro', saldo: 100, of_conta_id: null },
  ],
  transacoes: [
    { id: 'fin', grupo_id: 'g1', tipo: 'Gasto', categoria: 'Financiamento', valor: 3087.5, carteira_nome: 'Bradesco Pessoa Física', data: '2026-11-06', pago: true, transferencia: true, of_tx_id: 'OF-FIN', observacao: 'Itau Unibanco' },
    { id: 'pix', grupo_id: 'g1', tipo: 'Gasto', categoria: 'Pix enviado', valor: 4049.86, carteira_nome: 'Bradesco Pessoa Física', data: '2026-10-20', pago: true, transferencia: false, of_tx_id: 'OF-PIX', observacao: 'PIX ENVIADO - DES Fulano' },
    { id: 'tr', grupo_id: 'g1', tipo: 'Gasto', categoria: 'Transferências', valor: 500, carteira_nome: 'Bradesco Pessoa Física', data: '2026-11-06', pago: true, transferencia: true, of_tx_id: 'OF-TR', observacao: 'TED' },
    { id: 'cartao', grupo_id: 'g1', tipo: 'Recebimento', categoria: 'Fatura', valor: 1194.87, carteira_nome: 'Mercado Pago Crédito', data: '2026-11-06', pago: true, transferencia: true, of_tx_id: 'OF-FAT', observacao: 'Pagamento da fatura' },
    { id: 'manual', grupo_id: 'g1', tipo: 'Gasto', categoria: 'Transferências', valor: 40, carteira_nome: 'Carteira', data: '2026-11-06', pago: true, transferencia: true, of_tx_id: null, observacao: 'para a poupança' },
    { id: 'outro', grupo_id: 'g2', tipo: 'Gasto', categoria: 'Financiamento', valor: 99, carteira_nome: 'Bradesco Pessoa Física', data: '2026-11-06', pago: true, transferencia: true, of_tx_id: 'OF-X', observacao: 'outro grupo' },
  ],
};

(async () => {
  const { ehTransferencia } = require('../src/services/resumoTransacoes');
  const saldos = (b) => b.tabelas.wallets.map((w) => `${w.id}:${w.saldo}`).join(',');

  // 2a. o caso do relato
  let b = criarBanco(CENARIO); let put = carregarRota(b); const saldoAntes = saldos(b);
  let r = await put('fin', { transferencia: false });
  const fin = b.tabelas.transacoes.find((t) => t.id === 'fin');
  ok(r.statusCode === 200, `tirar a marca do financiamento responde 200 (veio ${r.statusCode} ${JSON.stringify(r.body)})`);
  ok(fin.transferencia === false, 'a marca saiu');
  ok(!ehTransferencia(fin), '⚠️ o financiamento VOLTA a contar como gasto nos totais');
  ok(saldos(b) === saldoAntes, '⚠️ nenhum saldo mexeu');
  r = await put('fin', { transferencia: true });
  ok(r.statusCode === 200 && b.tabelas.transacoes.find((t) => t.id === 'fin').transferencia === true, 'e dá pra marcar de volta');
  ok(saldos(b) === saldoAntes, 'ainda sem mexer em saldo');

  // 2b. Pix pra si mesmo que o banco não marcou
  r = await put('pix', { transferencia: true });
  ok(r.statusCode === 200 && b.tabelas.transacoes.find((t) => t.id === 'pix').transferencia === true, 'marca o Pix pra si mesmo como transferência');
  ok(ehTransferencia(b.tabelas.transacoes.find((t) => t.id === 'pix')), 'e ele sai dos gastos');
  ok(saldos(b) === saldoAntes, 'sem mexer em saldo');

  // 2c. "Transferências" sem trocar a categoria → recusa e NADA grava
  b = criarBanco(CENARIO); put = carregarRota(b);
  r = await put('tr', { transferencia: false, observacao: 'nome novo' });
  const tr = b.tabelas.transacoes.find((t) => t.id === 'tr');
  ok(r.statusCode === 400, '"Transferências" sem nova categoria → 400');
  ok(tr.transferencia === true && tr.observacao === 'TED', '⚠️ recusou → nada foi gravado (nem a descrição que veio junto)');
  r = await put('tr', { transferencia: false, categoria: 'Financiamento' });
  ok(r.statusCode === 200 && b.tabelas.transacoes.find((t) => t.id === 'tr').transferencia === false, 'com a categoria nova, passa');

  // 2d. cartão e manual recusados; mas editar OUTRA coisa neles segue igual
  b = criarBanco(CENARIO); put = carregarRota(b); const s0 = saldos(b);
  r = await put('cartao', { transferencia: false });
  ok(r.statusCode === 409 && b.tabelas.transacoes.find((t) => t.id === 'cartao').transferencia === true, 'cartão: recusa e não grava');
  r = await put('cartao', { observacao: 'Pagamento da fatura de nov' });
  ok(r.statusCode === 200 && b.tabelas.transacoes.find((t) => t.id === 'cartao').observacao === 'Pagamento da fatura de nov', '⚠️ editar a descrição do cartão (sem pedir a troca) segue funcionando');
  r = await put('cartao', { observacao: 'de novo', transferencia: true });
  ok(r.statusCode === 200, '⚠️ mandar a MESMA marca que já tem não é troca: edita normal');
  r = await put('manual', { transferencia: false, categoria: 'Outros' });
  ok(r.statusCode === 409 && b.tabelas.transacoes.find((t) => t.id === 'manual').transferencia === true, 'manual: recusa e não grava');
  ok(saldos(b) === s0, 'nada disso mexeu em saldo');

  // 2e. outro grupo não é alcançado
  b = criarBanco(CENARIO); put = carregarRota(b);
  r = await put('outro', { transferencia: false });
  ok(b.tabelas.transacoes.find((t) => t.id === 'outro').transferencia === true, '⚠️ linha de OUTRO grupo não é alterada');

  // 2f. edição comum sem o campo: idêntica a antes
  b = criarBanco(CENARIO); put = carregarRota(b);
  r = await put('fin', { categoria: 'Moradia' });
  const f2 = b.tabelas.transacoes.find((t) => t.id === 'fin');
  ok(r.statusCode === 200 && f2.categoria === 'Moradia' && f2.transferencia === true, 'sem o campo, a marca fica como estava');

  console.log(`\n${total - falhas.length}/${total} verificações passaram`);
  if (falhas.length) { console.error('\n✗ FALHAS:\n  - ' + falhas.join('\n  - ')); process.exit(1); }
  console.log('✓ eval:marca-transferencia ok');
})().catch((e) => { console.error(e); process.exit(1); });
