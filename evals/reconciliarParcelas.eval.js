// =============================================================================
// EVAL — parcela do cartão: cálculo × histórico gravado
//
// ⚠️ A FATURA DIVERGENTE NÃO ERA ERRO DE CÁLCULO. Medido com o payload VIVO da
// API no cartão do relato (Mercado Pago), via /api/admin/of-debug:
//
//   descrição      charge   data crua     → data que o sync calcula
//   CHINOCA         1/3     2026-06-20      2026-06-20
//   CHINOCA         2/3     2026-06-20      2026-07-20
//   CHINOCA         3/3     2026-06-20      2026-08-20
//   PayU *ADI       2/2     2026-07-14      2026-08-13
//   JIM.COM PROSED  2/2     2026-08-03      2026-09-03
//
// Tudo certo. O emissor manda TODAS as parcelas com a data da COMPRA, e
// `normalizeTxCartao` já as desloca pra compra + (N−1) meses usando
// `charge_identificator`/`charge_number` — exatamente o que o doc de
// /credit-cards/{id}/transactions define ("número da parcela atual" /
// "quantidade total de parcelas").
//
// O que falhava: essas linhas JÁ EXISTIAM no banco com a data da compra
// (importadas antes desse cálculo), e `inserirTransacoes` dedupa por
// `of_tx_id`. A data certa nunca chegava à tabela. Fatura em aberto
// R$ 1.319,66 na Sora × R$ 1.596,17 no app do banco — a diferença eram as
// parcelas presas na fatura da compra.
// =============================================================================
const S = require('../src/services/polpCelcoinSync');
const { cicloPorCompetencia } = require('../src/services/cicloFatura');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

const HOJE = '2026-08-19';
const CARTAO = { dia_fechamento: 8, dia_vencimento: 13 };

// Payload REAL do cartão: parcela com marcador estruturado, todas na data da
// compra. Os valores e datas vieram do diagnóstico contra a API.
const tx = (id, nome, valor, data, n, total) => ({
  id, transaction_name: nome, credit_debit_type: 'DEBITO',
  brazilian_amount: { amount: String(valor), currency: 'BRL' },
  transaction_date_time: data,
  charge_identificator: n, charge_number: total,
});

const PAYLOAD = [
  tx('chi-1', 'CHINOCA', 56.67, '2026-06-20T18:15:06Z', 1, 3),
  tx('chi-2', 'CHINOCA', 56.66, '2026-06-20T18:15:06Z', 2, 3),
  tx('chi-3', 'CHINOCA', 56.66, '2026-06-20T18:15:06Z', 3, 3),
  tx('adi-1', 'PayU *ADIDAS', 140.00, '2026-07-14T00:14:02+00:00', 1, 2),
  tx('adi-2', 'PayU *ADI', 139.99, '2026-07-14T00:14:02+00:00', 2, 2),
  tx('pro-1', 'JIM.COM PROSED ESPECIALID', 79.87, '2026-08-03T22:31:55Z', 1, 2),
  tx('pro-2', 'JIM.COM PROSED ES', 79.86, '2026-08-03T22:31:55Z', 2, 2),
];

const norm = () => PAYLOAD.map((t) => S.normalizeTxCartao(t, HOJE));

// ── 1. O CÁLCULO — cada parcela na data em que é cobrada ─────────────────
console.log('── 1. a parcela N cai em compra + (N−1) meses ──');
{
  const n = norm();
  const dia = (i) => String(n[i].data).slice(0, 10);
  eq(dia(0), '2026-06-20', 'CHINOCA 1/3 fica na data da compra');
  eq(dia(1), '2026-07-20', 'CHINOCA 2/3 vai pro mês seguinte');
  eq(dia(2), '2026-08-20', 'CHINOCA 3/3 vai pro terceiro mês');
  eq(dia(4), '2026-08-13', 'PayU 2/2 — a data crua vira o dia em São Paulo');
  eq(dia(6), '2026-09-03', 'PROSED 2/2 vai pra setembro');
  eq(n[2].parcelaNum, 3, 'o marcador vem do charge_identificator');
  eq(n[2].parcelaTotal, 3, 'e o total do charge_number');
}
console.log('  ok');

// ── 2. O NÚMERO DO CLIENTE ───────────────────────────────────────────────
console.log('── 2. a fatura em aberto fecha com o banco ──');
{
  const n = norm();
  const ciclo = cicloPorCompetencia(CARTAO, '2026-09');       // 09/08 → 08/09
  const dentro = n.filter((t) => {
    const d = String(t.data).slice(0, 10);
    return d >= ciclo.ini && d < ciclo.fimExcl;
  });
  const soma = Math.round(dentro.reduce((s, t) => s + t.valor, 0) * 100) / 100;
  eq(soma, 276.51, 'as três parcelas que caem na fatura em aberto');

  const CICLO_SEM_PARCELAS = 1319.66;      // as compras normais do ciclo
  eq(Math.round((CICLO_SEM_PARCELAS + soma) * 100) / 100, 1596.17,
    'FATURA = 1.596,17, exatamente o app do banco');
}
console.log('  ok');

// ── 3. Nada some nem duplica ─────────────────────────────────────────────
console.log('── 3. o dinheiro só muda de fatura ──');
{
  const n = norm();
  const total = Math.round(n.reduce((s, t) => s + t.valor, 0) * 100) / 100;
  eq(total, 609.71, 'a soma das 7 linhas é a mesma do payload');

  const porCompetencia = ['2026-07', '2026-08', '2026-09'].map((comp) => {
    const c = cicloPorCompetencia(CARTAO, comp);
    return Math.round(n.filter((t) => {
      const d = String(t.data).slice(0, 10);
      return d >= c.ini && d < c.fimExcl;
    }).reduce((s, t) => s + t.valor, 0) * 100) / 100;
  });
  eq(porCompetencia.join('|'), '56.67|276.53|276.51', 'uma parcela de cada compra por fatura');
  eq(Math.round(porCompetencia.reduce((a, b) => a + b, 0) * 100) / 100, 609.71,
    'e a soma das faturas é o total: nada aparece nem some');
}
console.log('  ok');

// ── 4. `redistribuida` marca quem a reconciliação deve corrigir ──────────
//
// A 1ª parcela fica na data da compra e não tem o que reconciliar. Só a 2ª em
// diante foi deslocada — e é só nessas que o sync pode reescrever a linha já
// gravada.
console.log('── 4. só a parcela deslocada é reconciliada ──');
{
  const n = norm();
  eq(n[0].redistribuida, false, 'a 1ª parcela não é deslocada');
  eq(n[1].redistribuida, true, 'a 2ª é');
  eq(n[2].redistribuida, true, 'a 3ª também');
  eq(n.filter((t) => t.redistribuida).length, 4, 'quatro linhas a reconciliar neste cartão');

  // Compra à vista nunca entra.
  const avista = S.normalizeTxCartao(
    tx('x', 'MERCADO', 50, '2026-08-10T12:00:00Z', null, null), HOJE);
  eq(avista.redistribuida, false, 'compra à vista não é parcela');
  eq(avista.parcelaTotal, null, 'e não ganha marcador');
}
console.log('  ok');

// ── 5. A parcela FUTURA nasce não paga ───────────────────────────────────
//
// Ela ainda não foi cobrada — é isso que a faz contar como prevista, igual à
// compra parcelada digitada à mão.
console.log('── 5. parcela ainda não cobrada nasce não paga ──');
{
  const n = norm();
  eq(n[6].pago, false, 'PROSED 2/2 vence em setembro: não paga');
  eq(n[0].pago, true, 'a 1ª, já cobrada, nasce paga');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.log(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('✓ reconciliação de parcelas: todos os casos passaram');
