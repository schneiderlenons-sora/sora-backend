// =============================================================================
// EVAL do dia de fechamento/vencimento RECORRENTE do cartão (Open Finance).
//
// BUG REAL: `dia_fechamento`/`dia_vencimento` vinham de UMA fatura só — a mais
// recente (aberta, ou a última publicada quando não há aberta). O Mercado
// Pago NUNCA publica fatura em aberto (CLAUDE.md: "List Bills para no mês
// passado, já pago"), então cartão MP sempre caía nesse caminho frágil.
//
// Medido: app do Mercado Pago mostra fechamento dia 8; o painel mostrou 12
// (herdado de uma única fatura que fechou atrasada) — e num sync anterior,
// com outro dia isolado, o ciclo ficou curto e sumiu a transação real do
// dia 05/08 da tela "Detalhes do cartão".
//
// Correção: a MODA (dia mais frequente) entre as faturas conhecidas, não uma
// fatura só. Filtra o desvio pontual e estabiliza o valor entre syncs.
//
// Rodar:  npm run eval:dia-recorrente
// =============================================================================
const { diaMaisFrequente, normalizeCartao } = require('../src/services/polpCelcoinSync');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

const bill = (due, fecha, total) => ({ due_date: due, bill_closing_date: fecha, bill_total_amount: total });

// ── 1. Moda simples ─────────────────────────────────────────────────────────
console.log('── 1. moda entre faturas ──');
{
  eq(diaMaisFrequente([bill('2026-08-17','2026-08-08')], 'bill_closing_date'), 8, 'uma fatura só: usa ela mesma');
  eq(diaMaisFrequente([], 'bill_closing_date'), null, 'sem faturas: null');
  eq(diaMaisFrequente(null, 'bill_closing_date'), null, 'null não quebra');
  eq(diaMaisFrequente([{}], 'bill_closing_date'), null, 'fatura sem a data: null');
}
console.log('  ok');

// ── 2. O CASO REAL: 3 faturas fecham dia 8, uma (a mais recente) fecha dia 12 ─
console.log('── 2. caso real (Mercado Pago) ──');
{
  // `bills` vem em ordem DESC de vencimento (doc da Polp) — a mais nova primeiro.
  const bills = [
    bill('2026-08-17', '2026-08-12', null),  // mais recente: fechou atrasada
    bill('2026-07-17', '2026-07-08', 900),
    bill('2026-06-17', '2026-06-08', 850),
    bill('2026-05-17', '2026-05-08', 780),
  ];
  eq(diaMaisFrequente(bills, 'bill_closing_date'), 8, 'moda é 8 (3 votos), não 12 (o mais recente, 1 voto)');
  eq(diaMaisFrequente(bills, 'due_date'), 17, 'vencimento é unânime em 17');

  const n = normalizeCartao({ id: 'mp1', identification: { name: 'Mercado Pago (OF)' }, limits: [] }, bills, '2026-08-06');
  eq(n.extras.dia_fechamento, 8, 'normalizeCartao usa a moda, não a fatura isolada');
  eq(n.extras.dia_vencimento, 17, 'vencimento também');
}
console.log('  ok');

// ── 3. Empate: desempata pela mais RECENTE ──────────────────────────────────
console.log('── 3. empate ──');
{
  // 2 fecham dia 8, 2 fecham dia 10 — a MAIS NOVA fecha dia 10 (1ª no array).
  const bills = [
    bill('2026-08-17', '2026-08-10'),
    bill('2026-07-17', '2026-07-08'),
    bill('2026-06-17', '2026-06-10'),
    bill('2026-05-17', '2026-05-08'),
  ];
  eq(diaMaisFrequente(bills, 'bill_closing_date'), 10, 'empate 2×2 desempata pela ocorrência mais recente');
}
console.log('  ok');

// ── 4. Um mês curto (fevereiro) não pode virar o "novo padrão" ─────────────
console.log('── 4. mês curto não distorce ──');
{
  // Cartão fecha 31, mas em fevereiro a Celcoin manda bill_closing_date=28
  // (clamp do PRÓPRIO banco). A moda ainda tem de identificar 31 como o
  // padrão, porque ele aparece mais vezes que o 28 isolado de fevereiro.
  const bills = [
    bill('2026-08-05', '2026-07-31'),
    bill('2026-07-05', '2026-06-30'), // junho tem 30 dias — mais um "quase 31"
    bill('2026-06-05', '2026-05-31'),
    bill('2026-03-05', '2026-02-28'), // fevereiro: clamp do banco
    bill('2026-01-05', '2025-12-31'),
  ];
  // Aqui não há moda de verdade (31 aparece 3×, 30 e 28 1× cada) — o teste
  // confirma que 31 vence por contagem, não que o algoritmo "entende" clamp.
  eq(diaMaisFrequente(bills, 'bill_closing_date'), 31, '31 vence por aparecer mais vezes');
}
console.log('  ok');

// ── 5. Sem bills nenhuma: cai no fallback, não quebra ───────────────────────
console.log('── 5. sem faturas nenhuma ──');
{
  const n = normalizeCartao({ id: 'novo', identification: { name: 'Cartão Novo' }, limits: [] }, [], '2026-08-06');
  eq(n.extras.dia_fechamento, null, 'sem histórico, sem moda: null (não inventa)');
  eq(n.extras.dia_vencimento, null, 'idem vencimento');
}
console.log('  ok');

// ── Resultado ──────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ dia recorrente do cartão: todos os casos passaram');
