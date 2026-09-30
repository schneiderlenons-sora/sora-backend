// =============================================================================
// EVAL — parcelas de dívida no custo mensal da reserva de emergência.
//
// Relato (Marcelo, 26/09/2026): "na parte de conta de reserva ele não está
// considerando o que tem em dívidas e parcelas".
//
// Números REAIS da conta dele, usados abaixo:
//   Jeep Compass ... R$ 1.194,56/mês  (41/60, financiamento, manual)
//   casa Cajamar ... R$ 4.010,00/mês  (137/360, financiamento, manual)
//   Golf ........... R$ 1.092,35/mês  (5/48, financiamento, manual)
//   -------------------------------------------------------------
//   total .......... R$ 6.296,91/mês, e NENHUM pagamento lançado
//   gasto médio ..... R$ 4.929,64/mês → meta 6m R$ 29.577,83
//   com as parcelas . R$ 11.226,55/mês → meta 6m R$ 67.359,29
//
// Rodar:  node evals/custoMensalDividas.eval.js
// =============================================================================
const { custoMensalDividas } = require('../src/services/custoMensalDividas');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const perto = (a, b, m) => { if (Math.abs(a - b) > 0.005) falhas.push(`${m} (esperado ~${b}, veio ${a})`); };

// As três dívidas reais do relato.
const DIVIDAS_MARCELO = [
  { id: 'd1', titulo: 'Jeep Compass', tipo: 'financiamento', origem: 'manual', status: 'em_atraso', valor_parcela: 1194.56, parcelas_pagas: 41, parcelas_total: 60 },
  { id: 'd2', titulo: 'casa Cajamar', tipo: 'financiamento', origem: 'manual', status: 'em_atraso', valor_parcela: 4010,    parcelas_pagas: 137, parcelas_total: 360 },
  { id: 'd3', titulo: 'Golf',         tipo: 'financiamento', origem: 'manual', status: 'em_atraso', valor_parcela: 1092.35, parcelas_pagas: 5,  parcelas_total: 48 },
];

console.log('── 1. O CASO DO RELATO ──');
{
  const r = custoMensalDividas({ dividas: DIVIDAS_MARCELO, transacoes: [] });
  perto(r.parcelaMensal, 6296.91, '§1 as três parcelas somadas');
  eq(r.consideradas.length, 3, '§1 as três entram');
  eq(r.jaNosGastos.length, 0, '§1 nenhuma aparece nos gastos');
  // A maior vem primeiro: é ela que explica o número pra quem lê a tela.
  eq(r.consideradas[0].titulo, 'casa Cajamar', '§1 ordenado pelo maior');

  const gastoMedio = 4929.64;
  perto(gastoMedio + r.parcelaMensal, 11226.55, '§1 custo mensal total');
  perto((gastoMedio + r.parcelaMensal) * 6, 67359.30, '§1 meta de 6 meses');
}
console.log('  ok');

console.log('── 2. ⚠️ NÃO CONTAR EM DOBRO ──');
{
  // (a) o formato EXATO que o nosso debitarConta escreve.
  const comPagamento = custoMensalDividas({
    dividas: DIVIDAS_MARCELO,
    transacoes: [{ observacao: 'Pagamento: Jeep Compass', categoria: 'Dívidas', valor: 1194.56 }],
  });
  perto(comPagamento.parcelaMensal, 6296.91 - 1194.56, '§2 a dívida já paga sai da soma');
  eq(comPagamento.jaNosGastos.length, 1, '§2 …e é reportada como já lançada');

  // (b) lançamento à mão em categoria de dívida, com o valor da parcela.
  const porCategoria = custoMensalDividas({
    dividas: DIVIDAS_MARCELO,
    transacoes: [{ observacao: 'Prestação do apartamento', categoria: 'Empréstimos', valor: 4010 }],
  });
  perto(porCategoria.parcelaMensal, 6296.91 - 4010, '§2 categoria + valor da parcela também conta');

  // Valor perto mas fora da tolerância de 2% não casa.
  const longe = custoMensalDividas({
    dividas: DIVIDAS_MARCELO,
    transacoes: [{ observacao: 'x', categoria: 'Empréstimos', valor: 3500 }],
  });
  perto(longe.parcelaMensal, 6296.91, '§2 valor distante NÃO cancela a parcela');
}
console.log('  ok');

console.log('── 3. ⚠️ "CONTÉM O TÍTULO" SERIA UM DESASTRE ──');
{
  // Caso REAL da conta dele: dívida "Golf" e uma compra "Tapete Golf".
  // Por "contém", o tapete de R$ 53,37 apagaria um financiamento de R$ 1.092,35.
  const r = custoMensalDividas({
    dividas: DIVIDAS_MARCELO,
    transacoes: [
      { observacao: 'MERCADOLIVRE*Tapete Golf', categoria: 'Compras', valor: 53.37 },
      { observacao: 'MC Cajamar',               categoria: 'Supermercado', valor: 99.70 },
      { observacao: 'HAVAIANAS CAJAMAR',        categoria: 'Vestuário', valor: 59.99 },
    ],
  });
  perto(r.parcelaMensal, 6296.91, '⚠️ §3 compras com o nome parecido NÃO cancelam a dívida');
  eq(r.jaNosGastos.length, 0, '§3 nenhuma foi dada como lançada');
}
console.log('  ok');

console.log('── 4. o que NUNCA entra ──');
{
  const fora = [
    { id: 'a', titulo: 'Rotativo Nubank', tipo: 'cartao_rotativo', origem: 'manual', status: 'ativa', valor_parcela: 800, parcelas_pagas: 1, parcelas_total: 10 },
    { id: 'b', titulo: 'Crédito Pessoal', tipo: 'emprestimo', origem: 'polp-celcoin', status: 'ativa', valor_parcela: 629.51, parcelas_pagas: 2, parcelas_total: 36 },
    { id: 'c', titulo: 'Quitada',         tipo: 'emprestimo', origem: 'manual', status: 'quitada', valor_parcela: 500, parcelas_pagas: 10, parcelas_total: 10 },
    // ⚠️ QUITADA COM PARCELAS FALTANDO é caso REAL — a migration 172 existe
    // por causa dele (cliente marcou quitada por engano e o contador ficou em
    // 2/10). Sem checar o `status`, o contador a devolveria pra soma.
    { id: 'c2', titulo: 'Quitada antes do fim', tipo: 'emprestimo', origem: 'manual', status: 'quitada', valor_parcela: 450, parcelas_pagas: 2, parcelas_total: 10 },
    { id: 'd', titulo: 'Acabou',          tipo: 'emprestimo', origem: 'manual', status: 'ativa', valor_parcela: 300, parcelas_pagas: 12, parcelas_total: 12 },
    { id: 'e', titulo: 'Sem parcela',     tipo: 'emprestimo', origem: 'manual', status: 'ativa', valor_parcela: 0, parcelas_pagas: 0, parcelas_total: 10 },
  ];
  const r = custoMensalDividas({ dividas: fora, transacoes: [] });
  eq(r.parcelaMensal, 0, '⚠️ §4 rotativo, Open Finance, quitada, terminada e sem parcela: nenhuma entra');
  eq(r.consideradas.length, 0, '§4 lista vazia');
}
console.log('  ok');

console.log('── 5. o que ENTRA além de financiamento ──');
{
  // Compra parcelada SEM cartão vira dívida tipo 'parcelamento' — ela não gera
  // transação automática, então precisa contar.
  const dentro = [
    { id: 'a', titulo: 'Tablet',      tipo: 'parcelamento', origem: 'manual', status: 'ativa', valor_parcela: 170, parcelas_pagas: 2, parcelas_total: 10 },
    { id: 'b', titulo: 'Empréstimo',  tipo: 'emprestimo',   origem: 'manual', status: 'ativa', valor_parcela: 500, parcelas_pagas: 1, parcelas_total: 24 },
    { id: 'c', titulo: 'Crediário',   tipo: 'crediario',    origem: 'manual', status: 'ativa', valor_parcela: 90,  parcelas_pagas: 0, parcelas_total: 6 },
    // Sem `parcelas_total` não dá pra saber se acabou: conta, que é o que a
    // aba Dívidas mostra.
    { id: 'd', titulo: 'Sem total',   tipo: 'outro',        origem: 'manual', status: 'ativa', valor_parcela: 60 },
    // `origem` ausente é linha antiga, anterior à coluna: tratada como manual.
    { id: 'e', titulo: 'Antiga',      tipo: 'emprestimo',                       status: 'ativa', valor_parcela: 40, parcelas_pagas: 0, parcelas_total: 5 },
  ];
  const r = custoMensalDividas({ dividas: dentro, transacoes: [] });
  perto(r.parcelaMensal, 860, '§5 parcelamento, empréstimo, crediário, sem-total e sem-origem somam');
  eq(r.consideradas.length, 5, '§5 as cinco entram');
}
console.log('  ok');

console.log('── 6. bordas ──');
{
  eq(custoMensalDividas({ dividas: [], transacoes: [] }).parcelaMensal, 0, '§6 sem dívidas');
  eq(custoMensalDividas({ dividas: null, transacoes: null }).parcelaMensal, 0, '§6 null não quebra');
  eq(custoMensalDividas({ dividas: DIVIDAS_MARCELO, transacoes: null }).consideradas.length, 3, '§6 transações null');
  // Dívida sem título: o casamento por descrição não pode casar com tudo.
  const semTitulo = custoMensalDividas({
    dividas: [{ id: 'x', tipo: 'emprestimo', origem: 'manual', status: 'ativa', valor_parcela: 100, parcelas_pagas: 0, parcelas_total: 5 }],
    transacoes: [{ observacao: 'Pagamento: ', categoria: 'Mercado', valor: 55 }],
  });
  perto(semTitulo.parcelaMensal, 100, '⚠️ §6 dívida sem título não é cancelada por "Pagamento: " solto');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ custoMensalDividas: todos os casos passaram');
