// =============================================================================
// EVAL — pagamento de fatura que só aparece na CONTA (services/pagamentoFaturaConta.js)
//
// O erro que custa caro aqui é "quitar" uma fatura que não foi paga (sugerir
// uma saída qualquer como pagamento). Por isso: valor EXATO, janela do
// fechamento até 7 dias após o vencimento, só conta (nunca cartão) e par sem
// disputa nos dois lados.
//
// Rodar:  npm run eval:pagamento-fatura-conta
// =============================================================================
const P = require('../src/services/pagamentoFaturaConta');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// Caso real medido: Bradesco Aeternum, fatura de setembro R$ 8.508,53, paga
// por "PGTO PEND CARTAO" na conta Bradesco PF em 26/09.
const F = { cartao_id: 'k', cartao_nome: 'Bradesco Aeternum', competencia: '2026-09', fatura: 8508.53, restante: 8508.53, fim: '2026-09-18', venc: '2026-09-25' };
const S = { id: 's', grupo_id: 'g', tipo: 'Gasto', valor: 8508.53, carteira_nome: 'Bradesco PF', data: '2026-09-26T10:00:00Z', observacao: 'PGTO PEND CARTAO' };

console.log('── 1. o caso real ──');
{
  eq(P.paresPagamentoFatura([S], [F]).length, 1, '§1 a saída paga a fatura');
  eq(P.saidaPagaFatura({ ...S, valor: 8508.52 }, F), false, '§1 1 centavo de diferença: não');
  eq(P.saidaPagaFatura({ ...S, tipo: 'Recebimento' }, F), false, '§1 entrada não paga fatura');
  // pagamento PARCIAL já registrado: o restante também vale
  eq(P.saidaPagaFatura({ ...S, valor: 500 }, { ...F, restante: 500 }), true, '§1 bate com o RESTANTE');
  eq(P.saidaPagaFatura(S, { ...F, restante: 0 }), false, '§1 fatura já quitada: nada a sugerir');
}
console.log('  ok');

console.log('── 2. janela ──');
{
  eq(P.saidaPagaFatura({ ...S, data: '2026-09-18' }, F), false, '§2 NO dia do fechamento: é antes (abatimento)');
  eq(P.saidaPagaFatura({ ...S, data: '2026-09-19' }, F), true, '§2 dia seguinte ao fechamento: vale');
  eq(P.saidaPagaFatura({ ...S, data: '2026-10-02' }, F), true, '§2 7 dias após o vencimento: vale (atraso)');
  eq(P.saidaPagaFatura({ ...S, data: '2026-10-03' }, F), false, '§2 8 dias após: fora');
}
console.log('  ok');

console.log('── 3. disputa nos dois lados ──');
{
  eq(P.paresPagamentoFatura([S, { ...S, id: 's2' }], [F]).length, 0, '§3 duas saídas iguais pra uma fatura: não escolhe');
  const F2 = { ...F, cartao_id: 'k2', cartao_nome: 'Outro', competencia: '2026-09' };
  eq(P.paresPagamentoFatura([S], [F, F2]).length, 0, '§3 uma saída que serviria pra duas faturas: não escolhe');
  eq(P.paresPagamentoFatura([S], [F], new Set(['s'])).length, 0, '§3 saída já vinculada: fora');
}
console.log('  ok');

console.log('── 4. só conta, nunca cartão ──');
{
  const W = [{ grupo_id: 'g', nome: 'Bradesco PF', tipo: 'Corrente' }, { grupo_id: 'g', nome: 'Nubank', tipo: 'Crédito' }];
  const r = P.saidasDeConta([S, { ...S, id: 'c', carteira_nome: 'Nubank' }, { ...S, id: 'x', carteira_nome: 'Fantasma' }, { ...S, id: 'r', tipo: 'Recebimento' }], W);
  eq(r.length, 1, '§4 só a saída de conta que existe');
  eq(r[0].id, 's', '§4 é a da conta corrente');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ pagamento de fatura pela conta: todos os casos passaram');
