// =============================================================================
// EVAL de FUNDIR previsão manual × cobrança do banco (parte pura).
//
// O ponto perigoso: descartar a linha ERRADA. Se a fusão algum dia mantiver a
// previsão manual e apagar a do banco, o sync reimporta a cobrança (duplicata
// de volta) E a joga em of_tx_ignoradas (cobrança real sumindo pra sempre). Os
// testes abaixo travam que QUEM FICA é sempre a linha com of_tx_id, e que o par
// que não é "manual-pendente × banco" é RECUSADO.
//
// Rodar:  npm run eval:fusao
// =============================================================================
const { planoFusao, rotuloHerdado, escolherAbsorcoes } = require('../src/services/fusaoDuplicada');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

const banco = (o = {}) => ({ id: o.id || 'ofrow', of_tx_id: o.of || '01abc', pago: o.pago ?? true, observacao: o.obs ?? 'PIX ENVIADO', categoria: o.cat ?? 'Pix enviado' });
const manual = (o = {}) => ({ id: o.id || 'manrow', of_tx_id: null, pago: o.pago ?? false, observacao: o.obs ?? 'Consócio dos Unidos', categoria: o.cat ?? 'Investimentos' });

// ── 1. o caso real: manter o BANCO, descartar a previsão manual ────────────
console.log('── 1. mantém o banco, descarta a manual ──');
{
  const p = planoFusao(banco(), manual());
  ok(p.seguro === true, 'o par válido é seguro');
  ok(p.manterId === 'ofrow', 'QUEM FICA é a linha do banco (of_tx_id)');
  ok(p.descartarId === 'manrow', 'quem sai é a previsão manual');
  // a ordem dos argumentos não pode mudar a decisão
  const q = planoFusao(manual(), banco());
  ok(q.manterId === 'ofrow' && q.descartarId === 'manrow', 'ordem invertida dá o MESMO resultado');
}
console.log('  ok');

// ── 2. RECUSA o que não é "manual-pendente × banco" ────────────────────────
console.log('── 2. recusa pares que a fusão não trata ──');
{
  // dois do banco → recusa (apagar um jogaria em of_tx_ignoradas)
  ok(planoFusao(banco({ id: 'a' }), banco({ id: 'b' })).seguro === false, 'dois do banco: recusa');
  // dois manuais → recusa (nenhum protege com of_tx_id)
  ok(planoFusao(manual({ id: 'a' }), manual({ id: 'b' })).seguro === false, 'dois manuais: recusa');
  // manual JÁ PAGA × banco → recusa (não é previsão pendente; apagá-la estornaria saldo)
  ok(planoFusao(banco(), manual({ pago: true })).seguro === false, 'manual já paga: recusa');
  // mesma transação → recusa
  ok(planoFusao(banco({ id: 'x' }), banco({ id: 'x' })).seguro === false, 'mesma id: recusa');
  // faltando um lado → recusa
  ok(planoFusao(banco(), null).seguro === false, 'sem o segundo: recusa');
  ok(planoFusao(null, null).seguro === false, 'sem nenhum: recusa');
}
console.log('  ok');

// ── 3. a linha do banco NUNCA é a descartada ───────────────────────────────
console.log('── 3. invariante: a de of_tx_id nunca sai ──');
{
  // mesmo que a manual pareça "mais completa", quem tem of_tx_id fica
  const p = planoFusao(banco({ obs: '' , cat: '' }), manual({ obs: 'Aluguel', cat: 'Casa' }));
  ok(p.seguro && p.descartarId === 'manrow', 'manual com rótulo rico ainda é a descartada');
}
console.log('  ok');

// ── 4. rótulo herdado: só texto, e só quando existe ────────────────────────
console.log('── 4. herança de rótulo ──');
{
  ok(rotuloHerdado(manual({ obs: 'Consócio', cat: 'Investimentos' })).observacao === 'Consócio', 'herda observacao');
  ok(rotuloHerdado(manual({ obs: 'Consócio', cat: 'Investimentos' })).categoria === 'Investimentos', 'herda categoria');
  // vazio não herda (não apaga o que o banco já tem)
  ok(!('observacao' in rotuloHerdado(manual({ obs: '  ', cat: '' }))), 'observacao vazia não é herdada');
  ok(!('categoria' in rotuloHerdado(manual({ obs: '', cat: '' }))), 'categoria vazia não é herdada');
  ok(Object.keys(rotuloHerdado(null)).length === 0, 'sem previsão, nada a herdar');
  // NUNCA herda valor/data/pago — isso é a verdade do banco
  const h = rotuloHerdado({ observacao: 'x', categoria: 'y', valor: 999, data: '2020-01-01', pago: false });
  ok(!('valor' in h) && !('data' in h) && !('pago' in h), 'herança é SÓ rótulo, nunca valor/data/pago');
}
console.log('  ok');

// ── 5. absorção automática: só junta 1-pra-1 sem ambiguidade ───────────────
console.log('── 5. escolherAbsorcoes (automático, sem ambiguidade) ──');
{
  // "são a mesma" = mesmo valor E mesma conta (stub simples pro teste; na prod
  // é o ehDuplicata). Determinístico e de graça.
  const mesma = (p, c) => p.valor === c.valor && p.conta === c.conta;
  const P = (id, valor, conta) => ({ id, valor, conta });
  const C = (of, valor, conta) => ({ of_tx_id: of, valor, conta });

  // caso limpo: 1 previsão × 1 cobrança iguais → junta
  {
    const r = escolherAbsorcoes([P('p1', 405, 'BB')], [C('o1', 405, 'BB')], mesma);
    ok(r.length === 1 && r[0].previsao.id === 'p1' && r[0].cobranca.of_tx_id === 'o1', '1×1 igual junta');
  }
  // nada casa → vazio
  ok(escolherAbsorcoes([P('p1', 405, 'BB')], [C('o1', 999, 'BB')], mesma).length === 0, 'valor diferente não junta');
  ok(escolherAbsorcoes([P('p1', 405, 'BB')], [C('o1', 405, 'Nubank')], mesma).length === 0, 'conta diferente não junta');

  // ⚠️ AMBIGUIDADE lado COBRANÇA: uma cobrança casa com DUAS previsões iguais → NÃO junta nenhuma
  {
    const r = escolherAbsorcoes([P('p1', 405, 'BB'), P('p2', 405, 'BB')], [C('o1', 405, 'BB')], mesma);
    ok(r.length === 0, 'cobrança que casa com 2 previsões não junta (qual delas?)');
  }
  // ⚠️ AMBIGUIDADE lado PREVISÃO: duas cobranças iguais disputam a mesma previsão → NÃO junta
  {
    const r = escolherAbsorcoes([P('p1', 405, 'BB')], [C('o1', 405, 'BB'), C('o2', 405, 'BB')], mesma);
    ok(r.length === 0, 'duas cobranças disputando 1 previsão não juntam (qual paga?)');
  }
  // pares independentes: cada um 1×1 → junta os dois
  {
    const r = escolherAbsorcoes(
      [P('p1', 405, 'BB'), P('p2', 90, 'Nubank')],
      [C('o1', 405, 'BB'), C('o2', 90, 'Nubank')], mesma);
    ok(r.length === 2, 'dois pares independentes juntam os dois');
  }
  // cobrança sem of_tx_id é ignorada (não é do banco)
  ok(escolherAbsorcoes([P('p1', 405, 'BB')], [{ valor: 405, conta: 'BB' }], mesma).length === 0, 'cobrança sem of_tx_id fora');
  // previsão sem id é ignorada
  ok(escolherAbsorcoes([{ valor: 405, conta: 'BB' }], [C('o1', 405, 'BB')], mesma).length === 0, 'previsão sem id fora');
  // comparador que explode não derruba (try/catch por par)
  ok(escolherAbsorcoes([P('p1', 405, 'BB')], [C('o1', 405, 'BB')], () => { throw new Error('x'); }).length === 0, 'comparador que explode não junta nada');
}
console.log('  ok');

console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) {
  console.log('\n── Falhas ──');
  falhas.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}
