// =============================================================================
// EVAL da reconciliação PREVISÃO × cobrança real do Open Finance.
//
// Só a parte PURA (o casamento) — sem banco. É o ponto mais perigoso do
// sistema: casar demais faz um gasto REAL sumir dentro de uma previsão (o
// usuário nunca descobre); casar de menos deixa duplicata (ele vê e resolve).
// Na dúvida, NÃO casar é o erro barato — os testes abaixo travam isso.
//
// Rodar:   npm run eval:reconciliar
// =============================================================================
const R = require('../src/services/reconciliarPrevisto');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

const prev = (o) => ({
  id: o.id || 'p1', tipo: o.tipo || 'Gasto', valor: o.valor,
  data: o.data || '2026-08-13', carteira_nome: o.conta || 'Mercado Pago (OF)',
  observacao: o.obs || '[Previsto] Claude',
});
const real = (o) => ({
  tipo: o.tipo || 'Gasto', valor: o.valor, data: o.data || '2026-08-14',
  carteira_nome: o.conta || 'Mercado Pago (OF)', observacao: o.obs || 'ANTHROPIC* CLAUDE SUB',
});

// ── 1. O caso real que motivou tudo ────────────────────────────────────────
// Previsão "Claude R$113,50 dia 13" × cobrança "ANTHROPIC* CLAUDE SUB R$113,85
// em 14/08". Valor, data e descrição TODOS diferentes — só conta+valor+data
// aproximados permitem casar.
console.log('── 1. caso real (Claude/Anthropic) ──');
ok(R.casarPrevisao([prev({ valor: 113.5 })], real({ valor: 113.85 })) !== null,
  'previsão 113,50 tem de casar com a cobrança 113,85 (câmbio)');
console.log('  ok');

// ── 2. Tolerância de VALOR ────────────────────────────────────────────────
console.log('── 2. tolerância de valor (15% ou R$5) ──');
ok(R.valorCompativel(100, 110), '100 × 110 casa (10%)');
ok(R.valorCompativel(100, 115), '100 × 115 casa (limite de 15%)');
ok(!R.valorCompativel(100, 130), '100 × 130 NÃO pode casar (30%)');
ok(R.valorCompativel(20, 24), 'valor baixo usa o piso de R$5 (20 × 24)');
ok(!R.valorCompativel(20, 30), '20 × 30 é longe demais até com o piso');
ok(!R.valorCompativel(0, 100), 'valor zero não casa com nada');
console.log('  ok');

// ── 3. Janela de DATA ─────────────────────────────────────────────────────
console.log('── 3. janela de data (7 dias) ──');
ok(R.diasEntre('2026-08-13', '2026-08-14') === 1, 'diferença de 1 dia');
ok(R.casarPrevisao([prev({ valor: 113.5, data: '2026-08-13' })], real({ valor: 113.5, data: '2026-08-20' })) !== null,
  '7 dias depois ainda casa (cobrança em dia útil)');
ok(R.casarPrevisao([prev({ valor: 113.5, data: '2026-08-13' })], real({ valor: 113.5, data: '2026-08-25' })) === null,
  '12 dias depois NÃO casa — é outra compra');
console.log('  ok');

// ── 4. Guardas: o que NÃO pode ser engolido ───────────────────────────────
console.log('── 4. o que não pode casar ──');
ok(R.casarPrevisao([prev({ valor: 113.5, conta: 'Itaú Crédito' })], real({ valor: 113.5 })) === null,
  'conta diferente não casa (mesmo valor e data)');
ok(R.casarPrevisao([prev({ valor: 113.5, tipo: 'Gasto' })], real({ valor: 113.5, tipo: 'Recebimento' })) === null,
  'Gasto não pode ser quitado por Recebimento');
ok(R.casarPrevisao([], real({ valor: 113.5 })) === null, 'sem previsão, nada casa');
console.log('  ok');

// ── 5. Várias previsões: escolhe a MAIS PRÓXIMA em valor ──────────────────
// Duas assinaturas parecidas no mesmo dia/conta é o cenário em que casar
// errado troca uma pela outra — o desempate tem de ser determinístico.
console.log('── 5. desempate entre previsões ──');
{
  const a = prev({ id: 'a', valor: 100, obs: '[Previsto] Academia' });
  const b = prev({ id: 'b', valor: 113.5, obs: '[Previsto] Claude' });
  ok(R.casarPrevisao([a, b], real({ valor: 113.85 })).id === 'b', 'pega a de valor mais próximo');
  ok(R.casarPrevisao([a, b], real({ valor: 101 })).id === 'a', 'e o inverso também');
}
console.log('  ok');

console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) {
  console.log('\n── Falhas ──');
  falhas.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}
