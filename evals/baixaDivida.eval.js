// =============================================================================
// EVAL da sugestão "esse débito do extrato pagou a parcela" (services/baixaDivida.js).
//
// Errar pra MAIS sugere ligar uma compra qualquer a um empréstimo — e a pessoa,
// confiando, marca paga uma parcela que não foi. Errar pra MENOS deixa o relato
// do Robert como estava. Os dois lados estão travados aqui.
//
// Rodar:  npm run eval:baixa-divida
// =============================================================================
const { sugestoesBaixa, vencimentoAberto, ehDebitoDeEmprestimo } = require('../src/services/baixaDivida');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

const HOJE = '2026-10-30';
const div = (id, parcela, extra = {}) => ({
  id, titulo: id, valor_parcela: parcela, dia_vencimento: 20, status: 'ativa',
  parcelas_total: 120, parcelas_pagas: 50, data_inicio: '2022-05-03', ultimo_pagamento: null, ...extra,
});
const tx = (id, data, valor, extra = {}) => ({
  id, data, valor, tipo: 'Gasto', categoria: 'Empréstimos e Financiamentos', pago: true,
  carteira_nome: 'Banco do Brasil', observacao: id, ...extra,
});
const ids = (s) => s.map((x) => `${x.divida_id}=${x.transacao.id}`).sort();
const rodar = (dividas, transacoes, extra = {}) => sugestoesBaixa({ dividas, transacoes, hoje: HOJE, ...extra });

// ── §1. O caso real do Robert (valores da base, 30/10/2026) ──────────────────
console.log('§1 caso Robert');
{
  const dividas = [
    div('bb-720', 720.34, { origem: 'of' }),
    div('bb-79', 79.11, { origem: 'of', data_inicio: '2021-12-16' }),
    div('coop-cpp', 435.04, { parcelas_total: 9, parcelas_pagas: 0, data_inicio: '2026-10-01', status: 'em_atraso' }),
    div('coop-rpa', 101.51, { parcelas_total: 3, parcelas_pagas: 0, data_inicio: '2026-10-01', status: 'em_atraso' }),
    div('coop-renov', 474.21, { parcelas_total: 74, parcelas_pagas: 0, data_inicio: '2026-10-21' }),
  ];
  const transacoes = [
    tx('ago-727', '2026-08-21', 727.12), tx('ago-79', '2026-08-21', 79.78), tx('ago-coop', '2026-08-21', 1001.23),
    tx('set-727', '2026-09-22', 727.12), tx('set-79', '2026-09-22', 79.78), tx('set-coop', '2026-09-22', 1000.67),
    tx('out-727', '2026-10-20', 727.12, { observacao: 'PGTO CDC RENOV  984753560-BB CRÉDITO RENOVAÇÃO FUNCI' }),
    tx('out-79', '2026-10-20', 79.78, { observacao: 'PGTO CDC SALAR  101862424-BB CRÉDITO SALÁRIO FUNCI' }),
    tx('out-coop', '2026-10-20', 1000.08, { observacao: 'COOPERFORTE     COOPERFORTE' }),
  ];
  const s = rodar(dividas, transacoes);
  eq(ids(s), ['bb-720=out-727', 'bb-79=out-79'], '§1 só os dois do BB, com o débito de OUTUBRO');
  const s720 = s.find((x) => x.divida_id === 'bb-720');
  eq(s720 && s720.diferenca, 6.78, '§1 diferença mostrada (727,12 − 720,34)');
  eq(s720 && s720.vencimento, '2026-10-20', '§1 vencimento de outubro');
  ok(!s.some((x) => x.transacao.id === 'out-coop'), '§1 o débito único da Cooperforte NÃO é sugerido');
}
console.log('  ok');

// ── §2. Tolerância de valor ──────────────────────────────────────────────────
console.log('§2 tolerância');
{
  eq(rodar([div('d', 100)], [tx('t', '2026-10-20', 105)]).length, 1, '§2 +5% entra');
  eq(rodar([div('d', 100)], [tx('t', '2026-10-20', 105.02)]).length, 0, '§2 acima de 5% fica fora');
  eq(rodar([div('d', 100)], [tx('t', '2026-10-20', 95)]).length, 1, '§2 −5% entra');
  eq(rodar([div('d', 100)], [tx('t', '2026-10-20', 94.98)]).length, 0, '§2 abaixo de −5% fica fora');
  eq(rodar([div('d', 10)], [tx('t', '2026-10-20', 10.99)]).length, 1, '§2 parcela pequena: tolerância mínima de R$ 1');
  eq(rodar([div('d', 10)], [tx('t', '2026-10-20', 11.02)]).length, 0, '§2 e não mais que R$ 1');
}
console.log('  ok');

// ── §3. Janela em volta do vencimento ────────────────────────────────────────
console.log('§3 janela');
{
  eq(rodar([div('d', 100)], [tx('t', '2026-10-15', 100)]).length, 1, '§3 5 dias antes entra');
  eq(rodar([div('d', 100)], [tx('t', '2026-10-14', 100)]).length, 0, '§3 6 dias antes fica fora');
  eq(rodar([div('d', 100)], [tx('t', '2026-10-30', 100)]).length, 1, '§3 10 dias depois entra');
  const h = sugestoesBaixa({ dividas: [div('d', 100)], transacoes: [tx('t', '2026-10-31', 100)], hoje: '2026-11-01' });
  eq(h.length, 0, '§3 11 dias depois fica fora');
  // Instante real às 23h30 em SP ainda é dia 30 — fatiar a string daria 31,
  // fora da janela, e a sugestão sumiria.
  const inst = rodar([div('d', 100)], [tx('t', '2026-10-31T02:30:00+00:00', 100)]);
  eq(inst.length && inst[0].transacao.data, '2026-10-30', '§3 instante real é lido no fuso de SP');
}
console.log('  ok');

// ── §4. Qual vencimento está aberto ──────────────────────────────────────────
console.log('§4 vencimento aberto');
{
  eq(vencimentoAberto(div('d', 100), HOJE), '2026-10-20', '§4 depois do dia 20: outubro');
  eq(vencimentoAberto(div('d', 100), '2026-10-15'), '2026-10-20', '§4 a 5 dias do vencimento: já é o deste mês');
  eq(vencimentoAberto(div('d', 100), '2026-10-14'), '2026-09-20', '§4 a 6 dias: ainda é o do mês passado');
  eq(vencimentoAberto(div('d', 100, { ultimo_pagamento: '2026-10-20' }), HOJE), null, '§4 pago no dia: nada aberto');
  eq(vencimentoAberto(div('d', 100, { ultimo_pagamento: '2026-09-22' }), HOJE), '2026-10-20', '§4 só setembro pago: outubro aberto');
  eq(vencimentoAberto(div('d', 100, { status: 'quitada' }), HOJE), null, '§4 quitada');
  eq(vencimentoAberto(div('d', 100, { parcelas_pagas: 120 }), HOJE), null, '§4 todas as parcelas pagas');
  eq(vencimentoAberto(div('d', 100, { data_inicio: '2026-10-21' }), HOJE), null, '§4 contratada depois do vencimento');
  eq(vencimentoAberto(div('d', 100, { proximo_vencimento: '2026-11-20' }), HOJE), null, '§4 o banco diz que a próxima é novembro');
  eq(vencimentoAberto(div('d', 100, { proximo_vencimento: '2026-10-20' }), HOJE), '2026-10-20', '§4 banco confirmando outubro: aberto');
  eq(vencimentoAberto(div('d', 100, { dia_vencimento: 31 }), '2026-11-30'), '2026-11-30', '§4 dia 31 em novembro vira 30');
}
console.log('  ok');

// ── §5. O que nunca é débito de empréstimo ───────────────────────────────────
console.log('§5 filtros');
{
  const d = [div('d', 100)];
  eq(rodar(d, [tx('t', '2026-10-20', 100, { categoria: 'Mercado', observacao: 'SUPERMERCADO' })]).length, 0, '§5 compra de mesmo valor não é parcela');
  eq(rodar(d, [tx('t', '2026-10-20', 100, { categoria: 'Outros', observacao: 'PGTO CDC 123' })]).length, 1, '§5 descrição "CDC" basta');
  eq(rodar(d, [tx('t', '2026-10-20', 100, { categoria: 'Outros', observacao: 'Empréstimo pessoal' })]).length, 1, '§5 descrição "empréstimo" basta');
  eq(rodar(d, [tx('t', '2026-10-20', 100, { carteira_nome: 'Nubank Crédito' })], { carteirasCredito: new Set(['nubank crédito']) }).length, 0, '§5 cartão de crédito fica fora');
  eq(rodar(d, [tx('t', '2026-10-20', 100, { pago: false })]).length, 0, '§5 lançamento ainda pendente fica fora');
  eq(rodar(d, [tx('t', '2026-10-20', 100, { transferencia: true })]).length, 0, '§5 transferência fica fora');
  eq(rodar(d, [tx('t', '2026-10-20', 100, { tipo: 'Recebimento' })]).length, 0, '§5 entrada de dinheiro fica fora');
  eq(rodar(d, [tx('t', '2026-10-20', 100)], { ligadas: new Set(['t']) }).length, 0, '§5 débito já ligado a outra parcela fica fora');
  eq(rodar([div('d', 0)], [tx('t', '2026-10-20', 100)]).length, 0, '§5 dívida sem valor de parcela não recebe sugestão');
  // …nem com débito de centavos, que caberia na tolerância mínima de R$ 1.
  eq(rodar([div('d', 0)], [tx('t', '2026-10-20', 0.8)]).length, 0, '§5 parcela zerada não casa com débito de centavos');
  ok(!ehDebitoDeEmprestimo({ tipo: 'Gasto', categoria: 'Mercado', observacao: 'abcdcx' }), '§5 "cdc" dentro de palavra não conta');
}
console.log('  ok');

// ── §6. Disputa e um-para-um ─────────────────────────────────────────────────
console.log('§6 disputa');
{
  // Duas dívidas quase iguais disputando o mesmo débito: nenhuma.
  eq(rodar([div('a', 720.34), div('b', 721.00)], [tx('t', '2026-10-20', 727.12)]).length, 0, '§6 empate: nenhuma sugestão');
  // Uma muito mais parecida: vai pra ela.
  eq(ids(rodar([div('a', 720.34), div('b', 700)], [tx('t', '2026-10-20', 727.12)])), ['a=t'], '§6 a mais parecida leva');
  // Dois débitos pra uma dívida: o mais parecido.
  eq(ids(rodar([div('a', 720.34)], [tx('t1', '2026-10-20', 727.12), tx('t2', '2026-10-21', 722)])), ['a=t2'], '§6 o débito mais parecido');
  // Duas dívidas, dois débitos, cada um com o seu.
  eq(ids(rodar([div('a', 720.34), div('b', 79.11)], [tx('t1', '2026-10-20', 727.12), tx('t2', '2026-10-20', 79.78)])), ['a=t1', 'b=t2'], '§6 cada um com o seu');
}
console.log('  ok');

if (falhas.length) {
  console.error(`\n✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('\n✓ baixa de dívida pelo extrato: todos os casos passaram');
