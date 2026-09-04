// =============================================================================
// EVAL da próxima parcela de empréstimo do Open Finance.
//
// BUG DE ORIGEM (cliente): "a próxima parcela vence dia 06 de OUTUBRO", e o
// card dizia "próxima parcela em 2 dias" (06/09).
//
// ⚠️ E A PRIMEIRA CORREÇÃO PIOROU O CARD — é o que este eval existe pra impedir
// que volte. Eu calculei `first_instalment_due_date + paid_instalments meses`,
// supondo que as parcelas pagas fossem as N PRIMEIRAS. Não são: no Nubank a
// antecipação amortiza pelo FIM. O card passou a anunciar "em 214 dias".
//
// A regra certa é o MENOR ÍNDICE EM ABERTO, lido de `payments.releases[]`.
//
// Os dois contratos abaixo são payload REAL (conta de cliente, set/2026).
//
// Rodar:  npm run eval:proxima-parcela-of
// =============================================================================
const { normalizeDivida } = require('../src/services/polpCelcoinSync');

const falhas = [];
const eq = (a, b, msg) => {
  if (a === b) return;
  falhas.push(`${msg}\n      esperado: ${JSON.stringify(b)}\n      recebido: ${JSON.stringify(a)}`);
};

/** Monta um item de empréstimo no formato da Celcoin. */
function contrato({ first, due, total, pagas, indices, paymentIds, saldo, amount, parcela }) {
  return {
    id: 'x', product_sub_type: 'CREDITO_PESSOAL_SEM_CONSIGNACAO',
    contract_date: '2026-05-08', first_instalment_due_date: first, due_date: due,
    contract_amount: amount, next_instalment_amount: parcela, product_name: 'Credito Pessoal',
    scheduled_instalments: {
      total_number_of_instalments: total, paid_instalments: pagas, past_due_instalments: 0,
    },
    payments: {
      paid_instalments: pagas, contract_outstanding_balance: saldo,
      releases: indices.map((idx, i) => {
        const pid = paymentIds[i % paymentIds.length];
        return { paymentId: pid, instalmentId: String(idx) + pid, isOverParcelPayment: false,
                 paidDate: '2026-08-07', paidAmount: '100.00' };
      }),
    },
  };
}

const UUID_A = '69fdee24-6367-4e5b-9ecd-1e593557b003';
const UUID_B = '6a4cdedf-df90-41f2-a8c1-e726803777f0';

// ── 1. O CASO DO RELATO ──────────────────────────────────────────────────────
console.log('── 1. o contrato do relato (36 parcelas, 8 pagas) ──');
{
  // Payload real: índices pagos 0, 1 e 30..35. As 6 do fim são a antecipação.
  const n = normalizeDivida(contrato({
    first: '2026-08-06', due: '2029-07-06', total: 36, pagas: 8,
    indices: [0, 1, 30, 31, 32, 33, 34, 35], paymentIds: [UUID_A],
    saldo: '8451.18', amount: '8000.0000', parcela: '629.5130',
  }), 'emprestimo');

  eq(n.proximo_vencimento, '2026-10-06', 'próxima parcela = menor índice em aberto (2)');
  eq(n.parcelas_pagas, 8, 'a contagem do emissor está CERTA — 8 parcelas quitadas mesmo');
  eq(n.dia_vencimento, 6, 'dia do vencimento vem da 1ª parcela');
  eq(n.saldo_devedor, 8451.18, 'saldo devedor é o do banco, não restantes × parcela');

  // ⚠️ A ARMADILHA: "primeira + pagas" dá 06/04/2027 — 6 meses de erro.
  const errado = '2027-04-06';
  eq(n.proximo_vencimento === errado, false, 'NÃO pode ser primeira + quantidade de pagas');
}
console.log('  ok');

// ── 2. O SEGUNDO CONTRATO DA MESMA CONTA ─────────────────────────────────────
console.log('── 2. segundo contrato (48 parcelas, 11 pagas) ──');
{
  // Índices 0 e 38..47: a 1ª parcela foi paga adiantada e 10 vieram do fim.
  const n = normalizeDivida(contrato({
    first: '2026-09-10', due: '2030-08-10', total: 48, pagas: 11,
    indices: [0, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47], paymentIds: [UUID_B],
    saldo: '9069.95', amount: '8500.0000', parcela: '761.2429',
  }), 'emprestimo');

  eq(n.proximo_vencimento, '2026-10-10', 'menor índice em aberto é 1');
  eq(n.parcelas_pagas, 11, '11 quitadas de verdade');
}
console.log('  ok');

// ── 3. Sem release nenhuma → NÃO afirma nada ─────────────────────────────────
//
// É o que faz o painel voltar a derivar do calendário, como sempre fez, em vez
// de exibir uma data inventada. Emissor que não manda `releases` é o caso comum
// fora do Nubank.
console.log('── 3. sem releases ──');
{
  const n = normalizeDivida(contrato({
    first: '2026-08-06', due: '2029-07-06', total: 36, pagas: 8,
    indices: [], paymentIds: [UUID_A],
    saldo: '8451.18', amount: '8000.0000', parcela: '629.5130',
  }), 'emprestimo');
  eq(n.proximo_vencimento, null, 'sem release, sem data — o calendário assume');
}
console.log('  ok');

// ── 4. instalmentId em formato desconhecido é IGNORADO ───────────────────────
//
// O formato "índice + paymentId" foi MEDIDO, não documentado. Se um emissor
// mandar outra coisa, o certo é não deduzir nada — e não pescar os dígitos da
// frente, que num uuid começando por número daria índice absurdo.
console.log('── 4. formato inesperado ──');
{
  const item = contrato({
    first: '2026-08-06', due: '2029-07-06', total: 36, pagas: 2,
    indices: [0, 1], paymentIds: [UUID_A],
    saldo: '8451.18', amount: '8000.0000', parcela: '629.5130',
  });
  item.payments.releases.forEach((r) => { r.instalmentId = 'inst_012'; });  // sufixo não casa
  const n = normalizeDivida(item, 'emprestimo');
  eq(n.proximo_vencimento, null, 'sufixo que não é o paymentId → ignora a release');
}
console.log('  ok');

// ── 5. Contrato inteiro quitado ──────────────────────────────────────────────
console.log('── 5. todas as parcelas pagas ──');
{
  const n = normalizeDivida(contrato({
    first: '2026-01-06', due: '2026-12-06', total: 12, pagas: 12,
    indices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], paymentIds: [UUID_A],
    saldo: '0.00', amount: '1000.0000', parcela: '100.0000',
  }), 'emprestimo');
  eq(n.proximo_vencimento, null, 'não sobrou parcela em aberto');
}
console.log('  ok');

// ── 6. Um pagamento quita VÁRIAS parcelas ────────────────────────────────────
//
// Medido no payload: o mesmo `paymentId` aparece em 3 releases, índices 17, 18
// e 19. Sem o Set isso contaria uma parcela só.
console.log('── 6. um pagamento, várias parcelas ──');
{
  const n = normalizeDivida(contrato({
    first: '2026-01-06', due: '2027-12-06', total: 24, pagas: 4,
    indices: [0, 1, 2, 3], paymentIds: [UUID_A],   // todas com o MESMO paymentId
    saldo: '500.00', amount: '1000.0000', parcela: '100.0000',
  }), 'emprestimo');
  eq(n.proximo_vencimento, '2026-05-06', 'as 4 contam, a próxima é a de índice 4');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ próxima parcela do Open Finance: todos os casos passaram');
