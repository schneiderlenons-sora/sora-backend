// =============================================================================
// EVAL: conta do banco → caixa da empresa (migration 189).
//
// O que este eval trava:
//   1. transação nova vira lançamento "a classificar"; transferência e
//      aplicação viram "movimentação" (fora do DRE); rendimento NÃO;
//   2. nada antes de `importar_desde` entra (mês fechado não é reescrito);
//   3. já espelhada: o banco manda no valor/data/sentido/situação, e a
//      CATEGORIA da pessoa nunca é sobrescrita;
//   4. ⚠️ digitado à mão (mesmo sentido, mesmo valor no centavo, ≤3 dias) é
//      JUNTADO, nunca duplicado — e o pareamento é 1:1 e pelo mais próximo;
//      dinheiro, outra conta, 1 centavo ou 4 dias de diferença NÃO juntam;
//   5. ⚠️ órfão do banco (reprocesso do agregador trocou o id) é RELIGADO à
//      transação nova, com a categoria da pessoa intacta;
//   6. dia da transação no fuso de SP (data pura × instante real);
//   7. quem pode ser vinculada;
//   8. execução com banco falso: idempotente (2ª passada não muda nada),
//      conflito do índice único não derruba nem duplica.
//
// Rodar:  npm run eval:espelho-empresa
// =============================================================================
const {
  planejarEspelho, diaSP, ehMovimentacao, transacaoEhMovimento, motivoInelegivel,
  espelharConta, CAT_A_CLASSIFICAR, CAT_MOVIMENTACAO,
} = require('../src/services/espelhoContaEmpresa');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

const CTX = { contaId: 'conta-pj', empresaId: 'emp-1', userId: 'u1', desde: '2026-10-01' };
const tx = (id, o = {}) => ({ id, tipo: 'Gasto', valor: 100, data: '2026-10-10T15:00:00+00:00',
  categoria: 'Pix', observacao: `TX ${id}`, transferencia: false, pago: true, ...o });
const plano = (transacoes, lancamentos = []) => planejarEspelho({ ...CTX, transacoes, lancamentos });

// ── 1. categoria inicial ─────────────────────────────────────────────────
console.log('── 1. categoria inicial ──');
{
  const p = plano([
    tx('a'),
    tx('b', { transferencia: true }),
    tx('c', { categoria: '💰 Investimentos' }),
    tx('d', { tipo: 'Recebimento', categoria: 'Rendimentos' }),
    tx('e', { tipo: 'Recebimento', categoria: 'Transferências' }),
  ]);
  const cat = (id) => p.inserir.find((l) => l.transacao_id === id)?.categoria;
  eq(p.inserir.length, 5, '5 transações → 5 lançamentos');
  eq(cat('a'), CAT_A_CLASSIFICAR, 'Pix comum → a classificar');
  eq(cat('b'), CAT_MOVIMENTACAO, 'transferência → movimentação');
  eq(cat('c'), CAT_MOVIMENTACAO, 'aplicação (com emoji) → movimentação');
  eq(cat('d'), CAT_A_CLASSIFICAR, 'rendimento é receita de verdade, NÃO movimentação');
  eq(cat('e'), CAT_MOVIMENTACAO, 'categoria Transferências sem a flag → movimentação');
  const a = p.inserir.find((l) => l.transacao_id === 'a');
  eq(a.valor, 10000, 'valor em centavos');
  eq(a.tipo, 'saida', 'Gasto → saída');
  eq(a.origem, 'banco', 'origem banco');
  eq(a.conta_id, 'conta-pj', 'na conta vinculada');
  eq(a.status, 'pago', 'pago');
  eq(p.inserir.find((l) => l.transacao_id === 'd').tipo, 'entrada', 'Recebimento → entrada');
  const pend = plano([tx('f', { pago: false })]).inserir[0];
  eq(pend.status, 'pendente', 'transação pendente → lançamento pendente');
  eq(pend.pago_em, null, 'pendente sem data de pagamento');
  eq(plano([tx('z', { valor: 0 })]).inserir.length, 0, 'valor zero não entra');
  eq(plano([tx('z', { tipo: 'Transferência' })]).inserir.length, 0, 'tipo desconhecido não entra');
  eq(ehMovimentacao({ categoria: CAT_MOVIMENTACAO }), true, 'ehMovimentacao');
  eq(ehMovimentacao({ categoria: 'vendas' }), false, 'venda não é movimentação');
  eq(ehMovimentacao(null), false, 'nulo');
  eq(transacaoEhMovimento({ categoria: 'Pagamento de fatura' }), true, 'pagamento de fatura = movimentação');
}
console.log('  ok');

// ── 2. desde ─────────────────────────────────────────────────────────────
console.log('── 2. nada antes do vínculo ──');
{
  const p = plano([tx('velha', { data: '2026-09-30T15:00:00+00:00' }), tx('nova')]);
  eq(p.inserir.length, 1, 'só a do mês do vínculo');
  eq(p.inserir[0].transacao_id, 'nova', 'a de setembro ficou fora');
  // 01/10 às 01h UTC ainda é 30/09 no Brasil
  eq(plano([tx('x', { data: '2026-10-01T01:30:00+00:00' })]).inserir.length, 0, 'fuso: 30/09 22h30 em SP fica fora');
}
console.log('  ok');

// ── 3. já espelhada ──────────────────────────────────────────────────────
console.log('── 3. já espelhada: banco manda no valor, pessoa na categoria ──');
{
  const espelhada = { id: 'l1', transacao_id: 'a', origem: 'banco', conta_id: 'conta-pj', tipo: 'saida',
    valor: 10000, data: '2026-10-10', status: 'pago', pago_em: '2026-10-10', categoria: 'fornecedor' };
  const igual = plano([tx('a')], [espelhada]);
  eq(igual.inserir.length + igual.atualizar.length + igual.juntar.length, 0, 'sem mudança → nada a fazer');
  const mudou = plano([tx('a', { valor: 120 })], [espelhada]);
  eq(mudou.inserir.length, 0, 'não insere de novo');
  eq(mudou.atualizar.length, 1, 'atualiza');
  eq(mudou.atualizar[0].patch.valor, 12000, 'valor novo do banco');
  eq('categoria' in mudou.atualizar[0].patch, false, '⚠️ categoria da pessoa não é tocada');
  eq('descricao' in mudou.atualizar[0].patch, false, 'descrição da pessoa não é tocada');
}
console.log('  ok');

// ── 4. juntar o que foi digitado ─────────────────────────────────────────
console.log('── 4. ⚠️ digitado à mão é juntado, nunca duplicado ──');
{
  const manual = (id, o = {}) => ({ id, transacao_id: null, origem: 'manual', conta_id: null, tipo: 'saida',
    valor: 10000, data: '2026-10-09', categoria: 'aluguel', forma_pagamento: 'pix', ...o });
  const p = plano([tx('a')], [manual('m1')]);
  eq(p.inserir.length, 0, 'não duplica');
  eq(p.juntar.length, 1, 'junta');
  eq(p.juntar[0].lancamentoId, 'm1', 'com o manual');
  eq(p.juntar[0].patch.conta_id, 'conta-pj', 'e o põe na conta vinculada');
  eq('categoria' in p.juntar[0].patch, false, 'a categoria digitada fica');
  eq(plano([tx('a')], [manual('m1', { valor: 10001 })]).juntar.length, 0, '1 centavo de diferença não junta');
  eq(plano([tx('a')], [manual('m1', { data: '2026-10-06' })]).juntar.length, 0, '4 dias de diferença não junta');
  eq(plano([tx('a')], [manual('m1', { tipo: 'entrada' })]).juntar.length, 0, 'sentido oposto não junta');
  eq(plano([tx('a')], [manual('m1', { forma_pagamento: 'dinheiro' })]).juntar.length, 0, 'dinheiro não passa pelo banco');
  eq(plano([tx('a')], [manual('m1', { conta_id: 'outra' })]).juntar.length, 0, 'lançamento de OUTRA conta não junta');
  eq(plano([tx('a')], [manual('m1', { conta_id: 'conta-pj' })]).juntar.length, 1, 'da mesma conta junta');
  // duas vendas iguais digitadas × duas do banco: 1:1, pelo mais próximo
  const p2 = plano([tx('a', { data: '2026-10-10T15:00:00+00:00' }), tx('b', { data: '2026-10-12T15:00:00+00:00' })],
    [manual('m1', { data: '2026-10-12' }), manual('m2', { data: '2026-10-10' })]);
  eq(p2.inserir.length, 0, 'nenhuma duplica');
  eq(p2.juntar.length, 2, 'as duas juntam');
  eq(p2.juntar.find((j) => j.transacaoId === 'a').lancamentoId, 'm2', 'pelo mais próximo (10 com 10)');
  eq(p2.juntar.find((j) => j.transacaoId === 'b').lancamentoId, 'm1', 'pelo mais próximo (12 com 12)');
  // três do banco, um digitado: junta um, insere dois
  const p3 = plano([tx('a'), tx('b'), tx('c')], [manual('m1')]);
  eq(p3.juntar.length, 1, 'junta só um');
  eq(p3.inserir.length, 2, 'os outros dois entram');
  // manual pendente (conta a pagar) confirmado pelo banco vira pago
  const p4 = plano([tx('a')], [manual('m1', { status: 'pendente' })]);
  eq(p4.juntar[0].patch.status, 'pago', 'conta a pagar baixada pelo banco');
}
console.log('  ok');

// ── 4B. baixa de conta em aberto pelo vencimento ─────────────────────────
console.log('── 4B. ⚠️ conta a receber/pagar: baixa pelo VENCIMENTO ──');
{
  // Caso Robert: contrato fixo recebido toda semana, lançado como conta a receber.
  const aReceber = (id, venc, o = {}) => ({ id, transacao_id: null, origem: 'manual', conta_id: null, tipo: 'entrada',
    valor: 250000, data: '2026-10-01', vencimento: venc, status: 'pendente', categoria: 'servicos',
    forma_pagamento: 'pix', ...o });
  const pix = (id, dia) => tx(id, { tipo: 'Recebimento', valor: 2500, data: `${dia}T14:00:00+00:00` });

  const p1 = plano([pix('a', '2026-10-09')], [aReceber('s1', '2026-10-07'), aReceber('s2', '2026-10-14')]);
  eq(p1.inserir.length, 0, 'o Pix NÃO entra como receita nova');
  eq(p1.juntar[0].lancamentoId, 's1', 'quita a conta a receber da semana');
  eq(p1.juntar[0].patch.status, 'pago', 'que vira paga');
  eq(p1.juntar[0].patch.pago_em, '2026-10-09', 'na data do Pix');
  eq('data' in p1.juntar[0].patch, false, '⚠️ a competência (data) da mensalidade fica');

  // Dia 11: mais perto da parcela do dia 14 — mas quita a MAIS ANTIGA (dia 7).
  const p2 = plano([pix('a', '2026-10-11')], [aReceber('s1', '2026-10-07'), aReceber('s2', '2026-10-14')]);
  eq(p2.juntar[0].lancamentoId, 's1', '⚠️ quita a mais antiga em aberto, não a mais próxima');

  // Duas semanas pagas: cada Pix quita uma parcela, sem repetir.
  const p3 = plano([pix('a', '2026-10-07'), pix('b', '2026-10-14')], [aReceber('s1', '2026-10-07'), aReceber('s2', '2026-10-14')]);
  eq(p3.juntar.length, 2, 'as duas semanas quitadas');
  eq(new Set(p3.juntar.map((j) => j.lancamentoId)).size, 2, 'uma parcela por Pix');
  eq(p3.inserir.length, 0, 'nada duplicado');

  // Fora da janela (7 dias): não arrisca — entra como receita a classificar.
  const p4 = plano([pix('a', '2026-10-14')], [aReceber('s1', '2026-10-07')]);
  eq(p4.juntar.length, 0, '7 dias depois do vencimento não quita sozinho');
  eq(p4.inserir.length, 1, 'entra como lançamento novo');
  eq(plano([pix('a', '2026-10-09')], [aReceber('s1', '2026-10-07', { valor: 249999 })]).juntar.length, 0, 'valor diferente no centavo não quita');
  eq(plano([tx('a', { valor: 2500, data: '2026-10-09T14:00:00+00:00' })], [aReceber('s1', '2026-10-07')]).juntar.length, 0, 'saída não quita conta a RECEBER');

  // Conta a pagar já projetada.
  const aPagar = { ...aReceber('p1', '2026-10-10'), tipo: 'saida', categoria: 'aluguel' };
  eq(plano([tx('a', { valor: 2500, data: '2026-10-10T14:00:00+00:00' })], [aPagar]).juntar[0]?.lancamentoId, 'p1', 'conta a pagar baixada pelo débito');

  // Já quitada pelo banco: na passada seguinte só a SITUAÇÃO acompanha.
  const quitada = { ...aReceber('s1', '2026-10-07'), transacao_id: 'a', status: 'pago', pago_em: '2026-10-09' };
  const p5 = plano([pix('a', '2026-10-09')], [quitada]);
  eq(p5.atualizar.length, 0, '⚠️ a competência da mensalidade não é trocada pela data do Pix');

  // ⚠️ As 4 semanas cadastradas NO MESMO DIA (data 01/10): a data de criação
  // não diz nada — quem decide é o vencimento. Ids escolhidos pra que a
  // ordem alfabética apontasse a parcela ERRADA (a da última semana).
  const mesmoDia = [aReceber('z1', '2026-10-07'), aReceber('a4', '2026-10-28')];
  const p7 = plano([pix('a', '2026-10-03')], mesmoDia);
  eq(p7.juntar[0]?.lancamentoId, 'z1', '⚠️ conta em aberto casa pelo VENCIMENTO, nunca pela data de cadastro');

  // Já digitado como pago tem prioridade sobre a conta em aberto.
  const p6 = plano([pix('a', '2026-10-07')], [aReceber('s1', '2026-10-07'),
    { ...aReceber('m1', null), status: 'pago', data: '2026-10-07' }]);
  eq(p6.juntar[0].lancamentoId, 'm1', 'o recebimento já digitado casa antes da conta em aberto');
}
console.log('  ok');

// ── 5. órfão de reprocesso ───────────────────────────────────────────────
console.log('── 5. ⚠️ órfão do reprocesso é religado ──');
{
  const orfao = { id: 'l9', transacao_id: null, origem: 'banco', conta_id: 'conta-pj', tipo: 'saida',
    valor: 10000, data: '2026-10-10', categoria: 'fornecedor', forma_pagamento: 'transferencia' };
  const p = plano([tx('novo-id')], [orfao]);
  eq(p.inserir.length, 0, 'não entra de novo');
  eq(p.juntar.length, 1, 'religa');
  eq(p.juntar[0].lancamentoId, 'l9', 'ao órfão');
  eq('categoria' in p.juntar[0].patch, false, 'a categoria "fornecedor" que a pessoa deu fica');
  const deOutraConta = { ...orfao, conta_id: 'outra' };
  eq(plano([tx('novo-id')], [deOutraConta]).juntar.length, 0, 'órfão de OUTRA conta não religa');
}
console.log('  ok');

// ── 6. dia em SP ─────────────────────────────────────────────────────────
console.log('── 6. dia da transação no fuso de SP ──');
eq(diaSP('2026-10-01T00:00:00+00:00'), '2026-10-01', 'data pura (meia-noite UTC) é o próprio dia');
eq(diaSP('2026-10-01T00:00:00.000Z'), '2026-10-01', 'data pura com Z');
eq(diaSP('2026-10-01T01:30:00+00:00'), '2026-09-30', 'instante 01h30 UTC é dia anterior em SP');
eq(diaSP('2026-10-01T15:00:00+00:00'), '2026-10-01', 'instante à tarde');
eq(diaSP('2026-10-01'), '2026-10-01', 'só a data');
console.log('  ok');

// ── 7. quem pode ser vinculada ───────────────────────────────────────────
console.log('── 7. quem pode ser vinculada ──');
eq(motivoInelegivel({ of_conta_id: 'x', tipo: 'Corrente', moeda: 'BRL' }), null, 'corrente do banco em real');
eq(motivoInelegivel({ of_conta_id: 'x', tipo: 'Poupança', moeda: null }), null, 'poupança sem moeda (= real)');
eq(typeof motivoInelegivel({ of_conta_id: null, tipo: 'Corrente' }), 'string', 'conta manual não');
eq(typeof motivoInelegivel({ of_conta_id: 'x', tipo: 'Crédito' }), 'string', 'cartão ainda não');
eq(typeof motivoInelegivel({ of_conta_id: 'x', tipo: 'Corrente', moeda: 'USD' }), 'string', 'outra moeda não');
eq(typeof motivoInelegivel(null), 'string', 'inexistente');
console.log('  ok');

// ── 8. execução com banco falso ──────────────────────────────────────────
function bancoFalso({ conta, wallet, transacoes, lancamentos, conflitoNaPrimeira = false }) {
  const t = { contas_negocio: [conta], wallets: [wallet], transacoes, lancamentos_negocio: lancamentos.map((l) => ({ ...l })) };
  let seq = 1, conflito = conflitoNaPrimeira;
  const from = (tabela) => {
    const filtros = []; let modo = 'select', patch = null, rows = null;
    const casa = (r) => filtros.every((f) => f(r));
    const api = {
      select() { return api; },
      eq(k, v) { filtros.push((r) => r[k] === v); return api; },
      gte(k, v) { filtros.push((r) => String(r[k]) >= v); return api; },
      in(k, vs) { filtros.push((r) => vs.includes(r[k])); return api; },
      is(k, v) { filtros.push((r) => (r[k] ?? null) === v); return api; },
      order() { return api; },
      update(p) { modo = 'update'; patch = p; return api; },
      insert(r) { modo = 'insert'; rows = Array.isArray(r) ? r : [r]; return api; },
      async range(a, b) { return { data: t[tabela].filter(casa).slice(a, b + 1), error: null }; },
      async maybeSingle() { return { data: t[tabela].find(casa) || null, error: null }; },
      then(res, rej) {
        let out = { data: null, error: null };
        if (modo === 'insert') {
          const dup = rows.some((r) => r.transacao_id && t.lancamentos_negocio.some((x) => x.transacao_id === r.transacao_id));
          if (conflito && rows.length > 1) { conflito = false; out = { data: null, error: { code: '23505', message: 'dup' } }; }
          else if (dup) out = { data: null, error: { code: '23505', message: 'dup' } };
          else rows.forEach((r) => t.lancamentos_negocio.push({ id: `n${seq++}`, ...r }));
        } else if (modo === 'update') {
          t[tabela].filter(casa).forEach((r) => Object.assign(r, patch));
        }
        return Promise.resolve(out).then(res, rej);
      },
    };
    return api;
  };
  return { client: { from }, t };
}

(async () => {
  console.log('── 8. execução: idempotente e à prova de corrida ──');
  const base = () => ({
    conta: { id: 'conta-pj', empresa_id: 'emp-1', user_id: 'u1', wallet_id: 'w-pj', importar_desde: '2026-10-01', ativa: true },
    wallet: { id: 'w-pj', grupo_id: 'g1', nome: 'Mercado Pago PJ', tipo: 'Corrente', moeda: 'BRL', of_conta_id: 'of-1' },
    transacoes: [
      { ...tx('a'), grupo_id: 'g1', carteira_nome: 'Mercado Pago PJ' },
      { ...tx('b', { transferencia: true }), grupo_id: 'g1', carteira_nome: 'Mercado Pago PJ' },
      { ...tx('c', { valor: 55 }), grupo_id: 'g1', carteira_nome: 'Mercado Pago PJ' },
      { ...tx('pessoal'), grupo_id: 'g1', carteira_nome: 'Nubank' },   // outra carteira: NÃO entra
    ],
    lancamentos: [{ id: 'm1', empresa_id: 'emp-1', transacao_id: null, origem: 'manual', conta_id: null,
      tipo: 'saida', valor: 5500, data: '2026-10-10', categoria: 'fornecedor', forma_pagamento: 'pix' }],
  });
  {
    // ⚠️ Conta a receber CADASTRADA EM AGOSTO que vence nesta semana: a busca
    // por data do lançamento não a traria; a busca por vencimento traz.
    const cenario = base();
    cenario.transacoes.push({ ...tx('r', { tipo: 'Recebimento', valor: 2500, data: '2026-10-09T14:00:00+00:00' }),
      grupo_id: 'g1', carteira_nome: 'Mercado Pago PJ' });
    cenario.lancamentos.push({ id: 'ago', empresa_id: 'emp-1', transacao_id: null, origem: 'manual', conta_id: null,
      tipo: 'entrada', valor: 250000, data: '2026-08-01', vencimento: '2026-10-07', status: 'pendente',
      categoria: 'servicos', forma_pagamento: 'pix' });
    const b = bancoFalso(cenario);
    const r = await espelharConta('conta-pj', { supabase: b.client });
    const ago = b.t.lancamentos_negocio.find((l) => l.id === 'ago');
    eq(ago.transacao_id, 'r', 'a conta de agosto que vence agora foi quitada pelo Pix');
    eq(ago.status, 'pago', 'e está paga');
    eq(ago.data, '2026-08-01', 'com a competência de agosto preservada');
    eq(b.t.lancamentos_negocio.some((l) => l.transacao_id === 'r' && l.id !== 'ago'), false, 'o Pix não entrou duplicado');
    eq(r.juntados, 2, 'juntou o digitado e a conta a receber');
  }
  {
    const b = bancoFalso(base());
    const r1 = await espelharConta('conta-pj', { supabase: b.client });
    eq(r1.inseridos, 2, '1ª passada: insere a e b');
    eq(r1.juntados, 1, '1ª passada: junta c com o digitado');
    eq(b.t.lancamentos_negocio.length, 3, '3 lançamentos no caixa (nada da conta pessoal)');
    eq(b.t.lancamentos_negocio.some((l) => l.transacao_id === 'pessoal'), false, 'a transação da conta pessoal NÃO entrou');
    eq(b.t.lancamentos_negocio.find((l) => l.id === 'm1').categoria, 'fornecedor', 'o digitado manteve a categoria');
    const r2 = await espelharConta('conta-pj', { supabase: b.client });
    eq(r2.inseridos + r2.juntados + r2.atualizados, 0, '⚠️ 2ª passada não muda nada (idempotente)');
    eq(b.t.lancamentos_negocio.length, 3, 'continua com 3');
  }
  {
    const b = bancoFalso({ ...base(), conflitoNaPrimeira: true });
    const r = await espelharConta('conta-pj', { supabase: b.client });
    eq(r.inseridos, 2, 'conflito no lote → refaz um a um e insere os 2');
    eq(new Set(b.t.lancamentos_negocio.map((l) => l.transacao_id)).size, b.t.lancamentos_negocio.length, 'nenhuma transação repetida');
  }
  {
    const sem = base(); sem.conta.wallet_id = null;
    const b = bancoFalso(sem);
    const r = await espelharConta('conta-pj', { supabase: b.client });
    eq(r.inseridos, 0, 'conta sem vínculo não traz nada');
  }
  {
    const cartao = base(); cartao.wallet.tipo = 'Crédito';
    const b = bancoFalso(cartao);
    const r = await espelharConta('conta-pj', { supabase: b.client });
    eq(r.inseridos, 0, 'cartão vinculado (não deveria existir) não traz nada');
    eq(typeof r.motivo, 'string', 'e diz por quê');
  }
  console.log('  ok');

  console.log('');
  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ conta do banco → caixa da empresa: todos os casos passaram');
})().catch((e) => { console.error(e); process.exit(1); });
