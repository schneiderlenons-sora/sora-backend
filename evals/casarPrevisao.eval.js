// =============================================================================
// EVAL do casamento PREVISÃO × COBRANÇA DO BANCO.
//
// ⚠️ O QUE ESTE EVAL PROTEGE não é "achar o casamento" — é NÃO QUITAR A ERRADA.
// Uma previsão que fica sem baixa custa um toque ao usuário. Uma previsão
// quitada por engano corrompe o saldo projetado e a pessoa não tem como
// desconfiar: a linha simplesmente some, com ✓, como se estivesse tudo certo.
//
// Por isso a maior parte das asserções abaixo testa o que ele NÃO pode fazer
// sozinho, não o que ele acerta.
//
// Rodar:  npm run eval:casar-previsao
// =============================================================================
const { casar } = require('../src/services/casarPrevisao');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

const PREV = {
  recorrencia_id: 'r1', competencia: '2026-09', vencimento: '2026-09-10',
  valor: 1700, carteira: 'Inter', tipo: 'Gasto',
};
const tx = (o) => ({ id: 't1', data: '2026-09-10', valor: 1700, tipo: 'Gasto',
  carteira_nome: 'Inter', of_tx_id: 'of-1', recorrencia_id: null, ...o });

// ── 1. Caso limpo: casa e pode ser automático ───────────────────────────────
console.log('── 1. o caso limpo ──');
{
  const r = casar([PREV], [tx()]);
  eq(r.length, 1, 'acha a cobrança');
  eq(r[0].automatico, true, 'e o caso limpo pode ser automático');
  eq(r[0].transacao_id, 't1', 'aponta a transação certa');
}
console.log('  ok');

// ── 2. Pagamento ADIANTADO e ATRASADO — o caso do cliente ──────────────────
//
// "Se eu antecipo o pagamento, não consigo dar baixa naquele valor previsto."
console.log('── 2. adiantado e atrasado ──');
{
  eq(casar([PREV], [tx({ data: '2026-09-08' })]).length, 1, 'pago 2 dias ANTES casa');
  eq(casar([PREV], [tx({ data: '2026-09-14' })]).length, 1, 'pago 4 dias DEPOIS casa');
  eq(casar([PREV], [tx({ data: '2026-09-30' })]).length, 0, 'pago 20 dias depois NÃO casa');
}
console.log('  ok');

// ── 3. AMBIGUIDADE nunca vira baixa automática ─────────────────────────────
//
// ⚠️ Esta é a asserção mais importante do arquivo. É o cenário que o dono do
// produto levantou: duas contas de valor parecido na mesma semana.
console.log('── 3. ambiguidade derruba o automático ──');
{
  // duas previsões disputando a MESMA cobrança
  const p2 = { ...PREV, recorrencia_id: 'r2' };
  const r = casar([PREV, p2], [tx()]);
  eq(r.length, 2, 'as duas previsões acham a cobrança');
  eq(r.every((x) => x.automatico === false), true,
    'mas NENHUMA pode ser automática — duas previsões disputam a mesma cobrança');

  // duas cobranças parecidas para a MESMA previsão
  const r2 = casar([PREV], [tx(), tx({ id: 't2', of_tx_id: 'of-2', data: '2026-09-11' })]);
  eq(r2[0].automatico, false, 'duas cobranças na janela também derrubam o automático');
  eq(r2[0].transacao_id, 't1', 'e sugere a MAIS PRÓXIMA do vencimento');
}
console.log('  ok');

// ── 4. Conta de VALOR VARIÁVEL nunca é automática ──────────────────────────
//
// ⚠️ O valor é o sinal FORTE do casamento. Numa conta que varia ele não existe,
// então a confirmação humana é obrigatória — mesmo com a chave global ligada.
console.log('── 4. valor variável só sugere ──');
{
  const luz = { ...PREV, recorrencia_id: 'r9', valor: 200, valor_variavel: true };
  const r = casar([luz], [tx({ valor: 200.5, of_tx_id: 'of-9' })]);
  eq(r.length, 1, 'ainda SUGERE (o usuário confirma)');
  eq(r[0].automatico, false, 'mas nunca quita sozinha');
  eq(r[0].motivo, 'conta de valor variavel', 'e diz por quê');
}
console.log('  ok');

// ── 5. O que NÃO é candidato ───────────────────────────────────────────────
console.log('── 5. fora do casamento ──');
{
  eq(casar([PREV], [tx({ carteira_nome: 'Nubank' })]).length, 0, 'carteira diferente não casa');
  eq(casar([PREV], [tx({ valor: 1705 })]).length, 0, 'valor fora da tolerância não casa');
  eq(casar([PREV], [tx({ valor: 1700.90 })]).length, 1, 'dentro de R$ 1,00 casa');
  eq(casar([PREV], [tx({ of_tx_id: null })]).length, 0, 'transação MANUAL não entra (só cobrança do banco)');
  eq(casar([PREV], [tx({ recorrencia_id: 'rX' })]).length, 0, 'transação já amarrada não entra de novo');
  eq(casar([PREV], [tx({ tipo: 'Recebimento' })]).length, 0, 'tipo diferente não casa');
  eq(casar([{ ...PREV, carteira: null }], [tx()]).length, 0,
    'previsão SEM carteira não casa com nada — "quase certo" aqui vale zero');
}
console.log('  ok');

// ── 6. Carteira com acento/caixa diferente ainda casa ──────────────────────
//
// O resto da base compara carteira por `ilike`; comparar cru aqui faria
// "Cartão Inter" e "cartao inter" passarem por contas diferentes.
console.log('── 6. carteira normalizada ──');
{
  const p = { ...PREV, carteira: 'Conta Corrente' };
  eq(casar([p], [tx({ carteira_nome: 'conta corrente' })]).length, 1, 'ignora caixa');
  eq(casar([{ ...PREV, carteira: 'Cartão' }], [tx({ carteira_nome: 'cartao' })]).length, 1, 'ignora acento');
}
console.log('  ok');

// ── Resultado ───────────────────────────────────────────────────────────────
if (falhas.length) {
  console.error(`\n❌ ${falhas.length} falha(s):`);
  for (const f of falhas) console.error('  - ' + f);
  process.exit(1);
}
console.log('\n✅ casamento de previsão: todos os casos passaram');
