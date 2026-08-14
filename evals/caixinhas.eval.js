// =============================================================================
// EVAL das CAIXINHAS (saldos reservados do Open Finance).
//
// É dinheiro que o cliente vê como "guardado". Errar aqui não estoura em lugar
// nenhum: mostra um número plausível e errado. Os dois erros fáceis, ambos
// travados abaixo:
//
//   · `available_amount` é um ARRAY. Ler `.amount` direto devolve undefined e a
//     caixinha entra ZERADA — o cliente vê R$ 0,00 onde tem R$ 1.000.
//   · `amount` é STRING com até 4 casas ("1000.0400"). Somar sem arredondar
//     espalha centavo fantasma no total.
//
// Rodar:  npm run eval:caixinhas
// =============================================================================
const { normalizeCaixinha } = require('../src/services/polpCelcoinSync');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// ── 1. O caso do doc, ao pé da letra ────────────────────────────────────
console.log('── 1. exemplo da doc ──');
{
  const c = normalizeCaixinha({
    id: 12,
    account_id: 'acc-1',
    reserved_identification: 'uuid-reserva-1',
    reserved_name: 'Viagem Japão',
    available_amount: [{
      amount: '1000.0400',
      currency: 'BRL',
      remuneration: {
        rate_type: 'LINEAR', indexer: 'CDI', calculation: 'DIAS_UTEIS',
        rate_periodicity: 'MENSAL', pre_fixed_rate: null,
        post_fixed_indexer_percentage: '0.300000', indexer_additional_info: null,
      },
    }],
    updated_at: '2026-08-13T10:00:00.000000Z',
  }, 'acc-1');

  eq(c.externalId, 'uuid-reserva-1', 'usa reserved_identification como chave');
  ok(c.externalId !== '12', 'NÃO usa o `id` interno da Polp como chave');
  eq(c.nome, 'Viagem Japão', 'nome da caixinha');
  eq(c.saldo, 1000.04, 'string com 4 casas vira número com 2');
  eq(c.moeda, 'BRL', 'moeda');
  eq(c.indexador, 'CDI', 'indexador');
  eq(c.rate_type, 'LINEAR', 'tipo da taxa');
  eq(c.periodicidade, 'MENSAL', 'periodicidade');
  eq(c.calculo, 'DIAS_UTEIS', 'base de cálculo');
  eq(c.of_conta_id, 'acc-1', 'vinculada à conta');
}
console.log('  ok');

// ── 2. available_amount é ARRAY — soma todos os itens ───────────────────
console.log('── 2. array de saldos ──');
{
  const c = normalizeCaixinha({
    reserved_identification: 'r2', reserved_name: 'Reserva',
    available_amount: [
      { amount: '100.00', currency: 'BRL' },
      { amount: '250.50', currency: 'BRL' },
      { amount: '0.0100', currency: 'BRL' },
    ],
  }, 'acc-1');
  eq(c.saldo, 350.51, 'soma os três itens do array');

  // Objeto solto (defensivo: se a Polp mudar pra não-array, não zera).
  const c2 = normalizeCaixinha({
    reserved_identification: 'r3', available_amount: { amount: '77.70', currency: 'BRL' },
  }, 'acc-1');
  eq(c2.saldo, 77.7, 'aceita objeto solto sem virar 0');

  // ⚠️ O bug que este eval existe pra impedir.
  ok(c.saldo !== 0, 'array NUNCA pode virar saldo 0');
}
console.log('  ok');

// ── 3. Bordas ───────────────────────────────────────────────────────────
console.log('── 3. bordas ──');
{
  // Caixinha ativa e zerada é resposta válida (a doc diz que has_reserved_balance
  // "inclui reservas ativas mesmo com saldo zerado").
  const zero = normalizeCaixinha({
    reserved_identification: 'r4', reserved_name: 'Zerada', available_amount: [],
  }, 'acc-1');
  eq(zero.saldo, 0, 'lista vazia = saldo 0, e ainda assim existe');
  eq(zero.nome, 'Zerada', 'nome preservado');

  // reserved_name é null quando o usuário não nomeou.
  const semNome = normalizeCaixinha({
    reserved_identification: 'r5', reserved_name: null,
    available_amount: [{ amount: '10.00', currency: 'BRL' }],
  }, 'acc-1');
  eq(semNome.nome, 'Caixinha', 'sem nome vira "Caixinha", não "null"');

  // Sem remuneração (caixinha que não rende) — não pode explodir.
  eq(semNome.indexador, null, 'sem remuneração → indexador null');
  eq(semNome.taxa_pre, null, 'sem remuneração → taxa null');

  // Sem identificação nenhuma → descartada (não dá pra deduplicar).
  eq(normalizeCaixinha({ available_amount: [] }, 'acc-1'), null, 'sem id → descarta');

  // Só o `id` interno, sem UUID: usa como último recurso.
  eq(normalizeCaixinha({ id: 99, available_amount: [] }, 'acc-1').externalId, '99',
    'cai no id interno quando não há UUID');
}
console.log('  ok');

// ── 4. Remuneração pré-fixada ───────────────────────────────────────────
console.log('── 4. remuneração pré ──');
{
  const c = normalizeCaixinha({
    reserved_identification: 'r6',
    available_amount: [{
      amount: '500.00', currency: 'BRL',
      remuneration: {
        rate_type: 'EXPONENCIAL', indexer: 'PRE_FIXADO', calculation: 'DIAS_CORRIDOS',
        rate_periodicity: 'ANUAL', pre_fixed_rate: '0.150000',
        post_fixed_indexer_percentage: null,
      },
    }],
  }, 'acc-1');
  eq(c.indexador, 'PRE FIXADO', 'underscore vira espaço (fica legível na tela)');
  eq(c.taxa_pre, 15, '0.150000 → 15%');
  eq(c.indexador_pct, null, 'sem pós-fixado');
}
console.log('  ok');

// ── Resultado ────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ caixinhas: todos os casos passaram');
