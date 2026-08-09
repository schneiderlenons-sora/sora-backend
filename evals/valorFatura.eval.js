// =============================================================================
// EVAL do valor de uma transação NA FATURA do cartão.
//
// CASO DE ORIGEM (cliente Nubank via Open Finance, ago/2026): a fatura só sabia
// SOMAR. Estorno, cashback e "Crédito de parcelamento de compra" eram
// DESCARTADOS do cálculo — nunca subtraídos. A fatura da Sora ficava maior que
// a do banco e o limite comprometido nunca voltava depois de um reembolso.
//
// O que este eval trava:
//  · compra soma, estorno ABATE, pagamento de fatura é NEUTRO;
//  · o pagamento não pode abater aqui — ele já abate por `pagamentos_fatura`,
//    e contar nos dois lugares tira o valor em DOBRO da fatura;
//  · `Recebimento` SEM `transferencia` continua neutro — é a condição que
//    protege os 9 lançamentos medidos na base (1 "Salário" na carteira do
//    cartão + 8 "📦 Importado" de OFX, um deles com cara de pagamento);
//  · variante com emoji ('💳 Fatura') tem de ser reconhecida como pagamento;
//  · o "Fatura anterior" do rollover (Gasto + transferencia) segue somando.
//
// Rodar:  npm run eval:valor-fatura
// =============================================================================
const { valorNaFatura, somarFatura, ehPagamentoFaturaCat } = require('../src/services/valorFatura');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${b}, veio ${a})`);

const compra   = (v) => ({ tipo: 'Gasto', valor: v, categoria: 'Uber' });
const estorno  = (v) => ({ tipo: 'Recebimento', valor: v, categoria: 'Reembolso', transferencia: true });
const pagamento = (v) => ({ tipo: 'Recebimento', valor: v, categoria: 'Fatura', transferencia: true });

// ── 1. Os três casos que importam ────────────────────────────────────────
console.log('── 1. compra soma · estorno abate · pagamento é neutro ──');
{
  eq(valorNaFatura(compra(100)), 100, 'compra soma o valor cheio');
  eq(valorNaFatura(estorno(40)), -40, 'estorno ABATE (era descartado — o bug)');
  eq(valorNaFatura(pagamento(500)), 0, 'pagamento da fatura é NEUTRO (abate por pagamentos_fatura)');
  eq(valorNaFatura({ tipo: 'Recebimento', valor: 12, categoria: 'Reembolso', transferencia: true }), -12,
    'cashback/crédito de parcelamento também abate');
}
console.log('  ok');

// ── 2. O CASO DO CLIENTE ─────────────────────────────────────────────────
// "comprei um produto de 40 reais no crédito, pedi reembolso, o credor
//  devolveu o limite" → a fatura tem de voltar a zero e o limite, junto.
console.log('── 2. compra R$ 40 + estorno R$ 40 = fatura zero ──');
{
  eq(somarFatura([compra(40), estorno(40)]), 0, 'a compra estornada não deixa resíduo na fatura');
  eq(somarFatura([compra(250), compra(40), estorno(40)]), 250, 'só a compra estornada sai; o resto fica');

  // Antes do conserto: o estorno era ignorado e a fatura ficava em 40.
  const regraAntiga = (txs) => txs.filter((t) => t.tipo === 'Gasto').reduce((s, t) => s + t.valor, 0);
  eq(regraAntiga([compra(40), estorno(40)]), 40, 'a regra ANTIGA deixava R$ 40 fantasma (documenta o bug)');
}
console.log('  ok');

// ── 3. Pagamento não pode abater duas vezes ─────────────────────────────
console.log('── 3. pagamento da fatura não conta em dobro ──');
{
  // Ciclo: R$ 1.000 de compras, cliente pagou R$ 400 (que entra por
  // pagamentos_fatura). A SOMA do ciclo tem de continuar 1.000 — quem faz
  // `restante = fatura − pago` é o statusFatura.
  eq(somarFatura([compra(600), compra(400), pagamento(400)]), 1000,
    'o pagamento não pode ser descontado aqui; senão restante = 1000−400−400');

  eq(valorNaFatura({ tipo: 'Recebimento', valor: 400, categoria: '💳 Fatura', transferencia: true }), 0,
    'variante com EMOJI também é pagamento (ehPagamentoFatura do catálogo não pega essa)');
  eq(valorNaFatura({ tipo: 'Recebimento', valor: 400, categoria: 'Fatura cartão', transferencia: true }), 0,
    'nome legado da categoria também é pagamento');
  ok(ehPagamentoFaturaCat('💳 Fatura') && ehPagamentoFaturaCat('Fatura') && ehPagamentoFaturaCat('fatura cartao'),
    'as três formas de escrever "Fatura" são reconhecidas');
  ok(!ehPagamentoFaturaCat('Reembolso') && !ehPagamentoFaturaCat('Fatura anterior'),
    'Reembolso e "Fatura anterior" NÃO são pagamento de fatura');
}
console.log('  ok');

// ── 4. Regressão zero: o que existe hoje na base não muda ───────────────
// Medido antes de subir: 63 Recebimento em carteira de crédito — 54 com
// categoria 'Fatura' e 9 com transferencia=false. NENHUM pode virar abatimento.
console.log('── 4. os lançamentos que já existem na base seguem neutros ──');
{
  eq(valorNaFatura({ tipo: 'Recebimento', valor: 300, categoria: 'Salário', transferencia: false }), 0,
    'Salário lançado por engano na carteira do cartão NÃO abate a fatura');
  eq(valorNaFatura({ tipo: 'Recebimento', valor: 2129.45, categoria: '📦 Importado', transferencia: false }), 0,
    'linha de OFX (que pode ser o próprio pagamento) NÃO abate — evitaria double-count');
  eq(valorNaFatura({ tipo: 'Recebimento', valor: 20.63, categoria: '📦 Importado' }), 0,
    'sem a flag `transferencia` (undefined) também é neutro');
  eq(somarFatura([compra(100),
    { tipo: 'Recebimento', valor: 300, categoria: 'Salário', transferencia: false },
    { tipo: 'Recebimento', valor: 2129.45, categoria: '📦 Importado', transferencia: false }]), 100,
  'uma fatura só com esses recebimentos antigos fica idêntica ao que era');
}
console.log('  ok');

// ── 5. Rollover ("Fatura anterior") continua somando ────────────────────
console.log('── 5. rollover intacto ──');
{
  const faturaAnterior = { tipo: 'Gasto', valor: 250, categoria: 'Fatura', transferencia: true };
  eq(valorNaFatura(faturaAnterior), 250,
    '"Fatura anterior" é Gasto com transferencia=true e TEM de somar (é o saldo que rolou)');
  eq(somarFatura([faturaAnterior, compra(100)]), 350, 'soma junto com as compras do ciclo novo');
}
console.log('  ok');

// ── 6. Bordas ────────────────────────────────────────────────────────────
console.log('── 6. bordas ──');
{
  eq(valorNaFatura(null), 0, 'nulo não quebra');
  eq(valorNaFatura({}), 0, 'objeto vazio não quebra');
  eq(valorNaFatura({ tipo: 'Gasto' }), 0, 'sem valor = 0');
  eq(valorNaFatura({ tipo: 'Gasto', valor: -50 }), 50, 'valor negativo no banco vira positivo (usa módulo)');
  eq(valorNaFatura({ tipo: 'Transferência', valor: 90, transferencia: true }), 0, 'tipo desconhecido é neutro');
  eq(somarFatura([]), 0, 'lista vazia = 0');
  eq(somarFatura(null), 0, 'lista nula = 0');

  // Crédito maior que as compras não pode virar fatura NEGATIVA na tela.
  eq(somarFatura([compra(10), estorno(100)]), 0, 'crédito maior que a compra trava em 0, nunca negativo');

  // Centavos: soma de float não pode vazar 0.30000000000000004.
  eq(somarFatura([compra(0.1), compra(0.2)]), 0.3, 'arredonda centavo corretamente');
}
console.log('  ok');

// ── Resultado ────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ valor na fatura: todos os casos passaram');
