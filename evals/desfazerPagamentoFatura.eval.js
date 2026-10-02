// =============================================================================
// EVAL — desfazer o pagamento de fatura.
//
// Pergunta de cliente (01/10/2026): "paguei a fatura por engano numa conta
// manual, tem como reverter?". Não tinha — e o caminho intuitivo (apagar o
// lançamento na aba Transações) deixava a conta PIOR: o saldo voltava e a
// linha de `pagamentos_fatura` sobrevivia, mantendo a fatura como paga.
//
// Aqui o risco é CRIAR DINHEIRO: devolver saldo duas vezes, devolver o total
// numa conta que pagou só parte, ou devolver para quem não pagou. Cada um
// desses tem uma seção.
//
// Rodar:  node evals/desfazerPagamentoFatura.eval.js
// =============================================================================
const { podeDesfazer, planoDeDesfazer } = require('../src/services/desfazerPagamentoFatura');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

const PAGAMENTO = { id: 'p1', cartao_id: 'c1', competencia: '2026-10', valor: 565.18, transacao_id: 't1' };
const CARTAO_MANUAL = { id: 'c1', nome: 'Mercado pago Crédito', of_conta_id: null };
const CARTAO_BANCO  = { id: 'c2', nome: 'Nubank', of_conta_id: 'of-123' };
const TRANSACAO = { id: 't1', valor: 565.18, carteira_nome: 'Itaú' };
const CONTA = { id: 'w1', nome: 'Itaú', saldo: 1000, of_conta_id: null };

console.log('── 1. o caso da pergunta: conta manual, pagamento por engano ──');
{
  const v = podeDesfazer({ pagamento: PAGAMENTO, cartao: CARTAO_MANUAL, rollover: null });
  eq(v.ok, true, '§1 cartão manual pode desfazer');

  const p = planoDeDesfazer({ pagamento: PAGAMENTO, transacao: TRANSACAO, carteira: CONTA });
  eq(p.apagarTransacao, true, '§1 o lançamento é apagado');
  eq(p.devolverSaldo, true, '§1 o saldo volta');
  eq(p.valorDevolvido, 565.18, '§1 …no valor exato');
}
console.log('  ok');

console.log('── 2. ⚠️ CARTÃO DO BANCO NÃO SE DESFAZ ──');
{
  // O pagamento veio do extrato (registrarPagamentosDoOF). Apagar aqui é
  // enxugar gelo — o próximo sync o traz de volta.
  const v = podeDesfazer({ pagamento: PAGAMENTO, cartao: CARTAO_BANCO, rollover: null });
  eq(v.ok, false, '⚠️ §2 recusa em cartão sincronizado');
  eq(v.codigo, 'cartao_do_banco', '§2 com código próprio');
  eq(/sincronizado com o banco/.test(v.motivo), true, '§2 e o motivo explica por quê');
}
console.log('  ok');

console.log('── 3. ⚠️ ROLLOVER JÁ MATERIALIZADO: RECUSA ──');
{
  // A sobra virou lançamento na fatura seguinte. Desfazer o pagamento sem
  // desfazer o rollover deixaria DUAS faturas erradas.
  const v = podeDesfazer({
    pagamento: PAGAMENTO, cartao: CARTAO_MANUAL,
    rollover: { id: 'r1', status: 'rolado' },
  });
  eq(v.ok, false, '⚠️ §3 recusa quando a sobra já rolou');
  eq(v.codigo, 'rollover_feito', '§3 com código próprio');

  // 'aguardando' ainda NÃO virou lançamento — pode desfazer.
  eq(podeDesfazer({
    pagamento: PAGAMENTO, cartao: CARTAO_MANUAL,
    rollover: { id: 'r1', status: 'aguardando' },
  }).ok, true, '§3 rollover só aguardando não impede');
}
console.log('  ok');

console.log('── 4. ⚠️ PAGAMENTO DIVIDIDO: devolve o da TRANSAÇÃO, não o total ──');
{
  // Pagamento de R$ 565,18 dividido em duas contas: UMA linha em
  // `pagamentos_fatura` com o total e DUAS transações. Devolver o total à
  // conta de uma delas inventaria dinheiro nela.
  const p = planoDeDesfazer({
    pagamento: { ...PAGAMENTO, valor: 565.18 },
    transacao: { id: 't1', valor: 300, carteira_nome: 'Itaú' },
    carteira: CONTA,
  });
  eq(p.valorDevolvido, 300, '⚠️ §4 devolve os 300 da transação, não os 565,18 do registro');
  eq(p.valorPagamento, 565.18, '§4 e informa o valor do pagamento à parte');
}
console.log('  ok');

console.log('── 5. ⚠️ QUEM NÃO PAGOU NÃO RECEBE SALDO ──');
{
  // Pagamento EXTERNO (outra pessoa pagou): a transação existe, mas não saiu
  // de conta nenhuma do usuário — `carteira_nome` é null.
  const externo = planoDeDesfazer({
    pagamento: PAGAMENTO,
    transacao: { id: 't9', valor: 565.18, carteira_nome: null },
    carteira: null,
  });
  eq(externo.devolverSaldo, false, '⚠️ §5 pagamento externo não devolve saldo');
  eq(externo.valorDevolvido, 0, '§5 …nada é creditado');
  eq(externo.apagarTransacao, true, '§5 mas o lançamento sai');

  // Conta de Open Finance: saldo é do banco, nunca mexido à mão.
  const doBanco = planoDeDesfazer({
    pagamento: PAGAMENTO, transacao: TRANSACAO,
    carteira: { id: 'w2', nome: 'Itaú', saldo: 10, of_conta_id: 'of-9' },
  });
  eq(doBanco.devolverSaldo, false, '⚠️ §5 conta do banco não recebe saldo de volta');
  eq(doBanco.contaDoBanco, true, '§5 …e a tela é avisada pra poder dizer');

  // Conta que não existe mais (renomeada/excluída).
  const semConta = planoDeDesfazer({ pagamento: PAGAMENTO, transacao: TRANSACAO, carteira: null });
  eq(semConta.devolverSaldo, false, '§5 conta inexistente não recebe nada');
  eq(semConta.apagarTransacao, true, '§5 …mas o lançamento ainda sai');
}
console.log('  ok');

console.log('── 6. sem transação vinculada ──');
{
  // Os 14 registros da base com `transacao_id` nulo. Não há lançamento a
  // apagar nem saldo a devolver — resta limpar o registro, que é o que faz a
  // fatura voltar a aparecer em aberto.
  const p = planoDeDesfazer({ pagamento: { ...PAGAMENTO, transacao_id: null }, transacao: null, carteira: null });
  eq(p.apagarTransacao, false, '§6 não tenta apagar o que não existe');
  eq(p.devolverSaldo, false, '§6 e não devolve saldo');
  eq(p.valorPagamento, 565.18, '§6 o registro ainda é removido pelo valor conhecido');
}
console.log('  ok');

console.log('── 7. bordas ──');
{
  eq(podeDesfazer({}).ok, false, '§7 sem pagamento, recusa');
  eq(podeDesfazer({ pagamento: null }).codigo, 'nao_encontrado', '§7 com código');
  eq(podeDesfazer({ pagamento: PAGAMENTO, cartao: null, rollover: null }).ok, true,
    '§7 cartão não encontrado não bloqueia (o registro ainda pode sair)');
  // Valor zero ou ausente não vira devolução negativa.
  eq(planoDeDesfazer({ pagamento: { id: 'p', valor: 0 }, transacao: { id: 't', valor: 0, carteira_nome: 'Itaú' }, carteira: CONTA })
    .devolverSaldo, false, '§7 valor zero não mexe no saldo');
  eq(planoDeDesfazer({}).apagarTransacao, false, '§7 chamada vazia não quebra');
  // Moeda estrangeira: o saldo da conta é nativo, então devolve `valor_moeda`.
  eq(planoDeDesfazer({
    pagamento: PAGAMENTO,
    transacao: { id: 't1', valor: 565.18, valor_moeda: 100, carteira_nome: 'Nomad' },
    carteira: { id: 'w3', nome: 'Nomad', saldo: 500, of_conta_id: null },
  }).valorDevolvido, 100, '⚠️ §7 conta em outra moeda recebe o valor NATIVO, não o convertido');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ desfazerPagamentoFatura: todos os casos passaram');
