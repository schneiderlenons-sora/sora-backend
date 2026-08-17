// =============================================================================
// EVAL do detector de transações duplicadas (Detetive Watson).
//
// O RISCO AQUI É O FALSO POSITIVO, não o falso negativo. Acusar de duplicata
// dois Pix legítimos de R$ 17,80 pro mesmo comerciante no mesmo dia faz o
// usuário parar de confiar no agente — e um agente em quem não se confia é
// pior do que agente nenhum. Por isso a maioria dos casos aqui é do tipo
// "NÃO pode acusar".
//
// Números medidos na base real (4.357 gastos) que justificam a regra estreita:
//   · mesmo valor + carteira + descrição + ±1 dia .... 27 pares (maioria LEGÍTIMA)
//   · TIMESTAMP idêntico ao milissegundo .............. 6 pares (todos duplicata)
//
// Rodar:  npm run eval:duplicadas
// =============================================================================
const {
  acharDuplicadas, ehDuplicata, explicar, temHoraReal, diffDias,
} = require('../src/services/duplicadas');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };

const tx = (o) => ({
  id: Math.random().toString(36).slice(2), tipo: 'Gasto', valor: 50,
  carteira_nome: 'Nubank', observacao: 'Padaria', data: '2026-08-01T13:00:00.000+00:00',
  ...o,
});

// ── 1. A prova forte: mesmo instante ────────────────────────────────────
console.log('── 1. mesmo instante = duplicata ──');
{
  const a = tx({ id: 'a', data: '2026-06-08T18:48:00.324+00:00', valor: 19.44, observacao: 'MARCELO ALVES' });
  const b = tx({ id: 'b', data: '2026-06-08T18:48:00.324+00:00', valor: 19.44, observacao: 'MARCELO ALVES' });
  ok(ehDuplicata(a, b) === 'mesmo-instante', 'caso REAL da base: mesmo milissegundo é duplicata');

  // Um milissegundo de diferença já é outra compra — o banco distinguiu.
  const c = tx({ id: 'c', data: '2026-06-08T18:48:00.325+00:00', valor: 19.44, observacao: 'MARCELO ALVES' });
  ok(ehDuplicata(a, c) === null, '1 milissegundo de diferença NÃO é duplicata');
}
console.log('  ok');

// ── 2. O que NÃO pode ser acusado ───────────────────────────────────────
console.log('── 2. repetição legítima não é duplicata ──');
{
  // Caso REAL da base: dois Pix iguais pro mesmo comerciante, horas diferentes.
  const a = tx({ id: 'a', valor: 17.8, observacao: 'Pix BACHEGA', data: '2026-07-06T09:12:00+00:00', of_tx_id: 'x1' });
  const b = tx({ id: 'b', valor: 17.8, observacao: 'Pix BACHEGA', data: '2026-07-06T19:40:00+00:00', of_tx_id: 'x2' });
  ok(ehDuplicata(a, b) === null,
    'dois Pix iguais no mesmo dia em horas diferentes: o banco diz que são dois, e são');

  // Café de todo dia.
  const c = tx({ id: 'c', valor: 8, observacao: 'Cafe', data: '2026-08-01T08:00:00+00:00', of_tx_id: 'y1' });
  const d = tx({ id: 'd', valor: 8, observacao: 'Cafe', data: '2026-08-02T08:00:00+00:00', of_tx_id: 'y2' });
  ok(ehDuplicata(c, d) === null, 'mesmo café dois dias seguidos não é duplicata');

  // Valores diferentes, contas diferentes.
  ok(ehDuplicata(tx({ id: '1' }), tx({ id: '2', valor: 51 })) === null, 'valor diferente nunca casa');
  ok(ehDuplicata(tx({ id: '1' }), tx({ id: '2', carteira_nome: 'Itaú' })) === null, 'conta diferente nunca casa');

  // Parcela e recorrência repetem por natureza.
  ok(ehDuplicata(tx({ id: '1', parcela_total: 12, data: '2026-08-01T13:00:00+00:00' }),
                 tx({ id: '2', parcela_total: 12, data: '2026-08-01T13:00:00+00:00' })) === null,
    'parcela NUNCA é acusada (repete de propósito)');
  ok(ehDuplicata(tx({ id: '1', recorrente: true }), tx({ id: '2', recorrente: true })) === null,
    'recorrência NUNCA é acusada');
  ok(ehDuplicata(tx({ id: '1', transferencia: true }), tx({ id: '2', transferencia: true })) === null,
    'transferência não é consumo, fica fora');

  // Meia-noite = lançamento manual sem hora: a hora não prova nada.
  const m1 = tx({ id: 'm1', data: '2026-08-01T00:00:00+00:00' });
  const m2 = tx({ id: 'm2', data: '2026-08-01T00:00:00+00:00' });
  ok(ehDuplicata(m1, m2) === null,
    'dois manuais à meia-noite NÃO são acusados — a hora 00:00 não é prova de nada');
}
console.log('  ok');

// ── 3. Manual × banco: o caso do cliente ────────────────────────────────
console.log('── 3. digitou e o banco trouxe ──');
{
  const mao   = tx({ id: 'mao', valor: 89.9, observacao: 'Amazon', data: '2026-08-01T00:00:00+00:00' });
  const banco = tx({ id: 'of',  valor: 89.9, observacao: 'AMAZON BR', data: '2026-08-01T16:22:10+00:00', of_tx_id: 'z1' });
  ok(ehDuplicata(mao, banco) === 'manual-e-banco',
    'mesmo valor e conta, um digitado e outro do banco, no mesmo dia → duplicata');

  // A descrição do banco quase nunca bate com a que a pessoa digitou; por isso
  // a origem diferente é a prova, não o texto.
  ok(ehDuplicata(mao, tx({ id: 'x', valor: 89.9, observacao: 'AMAZON BR', data: '2026-08-05T16:22:10+00:00', of_tx_id: 'z2' })) === null,
    '4 dias depois já não casa (fora da janela de 1 dia)');

  // Dois do banco NÃO entram por esta regra.
  ok(ehDuplicata(tx({ id: 'p', of_tx_id: 'a', data: '2026-08-01T10:00:00+00:00' }),
                 tx({ id: 'q', of_tx_id: 'b', data: '2026-08-01T11:00:00+00:00' })) === null,
    'dois lançamentos do banco em horas diferentes não casam por origem');
}
console.log('  ok');

// ── 4. Agrupa (a mesma compra entrou 3 vezes na base real) ──────────────
console.log('── 4. agrupa em vez de listar pares ──');
{
  const base = { valor: 19.44, observacao: 'MARCELO ALVES', carteira_nome: 'Nubank',
                 data: '2026-06-08T18:48:00.324+00:00', tipo: 'Gasto' };
  const grupos = acharDuplicadas([
    { ...base, id: '1', created_at: '2026-06-08T20:00:00Z' },
    { ...base, id: '2', created_at: '2026-06-09T20:00:00Z' },
    { ...base, id: '3', created_at: '2026-06-10T20:00:00Z' },
    tx({ id: 'solta', valor: 12, observacao: 'Outra coisa' }),
  ]);
  ok(grupos.length === 1, `3 cópias viram UM grupo, não 3 pares (veio ${grupos.length})`);
  ok(grupos[0].transacoes.length === 3, `com as 3 juntas (veio ${grupos[0].transacoes.length})`);
  ok(grupos[0].transacoes[0].id === '1', 'a mais ANTIGA vem primeiro (é a que se mantém)');
  ok(explicar(grupos[0]).includes('3 vezes'), `a explicação diz quantas vezes: "${explicar(grupos[0])}"`);
}
console.log('  ok');

// ── 5. Lista limpa não gera alarme ──────────────────────────────────────
console.log('── 5. sem duplicata, silêncio ──');
{
  ok(acharDuplicadas([]).length === 0, 'lista vazia não quebra');
  ok(acharDuplicadas(null).length === 0, 'null não quebra');
  const normais = [
    tx({ id: '1', valor: 10, data: '2026-08-01T10:00:00+00:00', of_tx_id: 'a' }),
    tx({ id: '2', valor: 20, data: '2026-08-01T11:00:00+00:00', of_tx_id: 'b' }),
    tx({ id: '3', valor: 30, data: '2026-08-02T10:00:00+00:00', of_tx_id: 'c' }),
  ];
  ok(acharDuplicadas(normais).length === 0, 'compras diferentes não geram grupo');
}
console.log('  ok');

// ── 6. Utilitários ──────────────────────────────────────────────────────
console.log('── 6. utilitários ──');
{
  ok(temHoraReal('2026-08-01T13:45:00+00:00') === true, 'hora real é reconhecida');
  ok(temHoraReal('2026-08-01T00:00:00+00:00') === false, 'meia-noite não conta como hora');
  ok(temHoraReal('2026-08-01') === false, 'data sem hora não conta');
  ok(diffDias('2026-08-01T23:00:00Z', '2026-08-02T01:00:00Z') === 1, 'diferença de dias ignora a hora');
  ok(diffDias('2026-08-01', '2026-08-01') === 0, 'mesmo dia = 0');
}
console.log('  ok');

// ── 7. SUSPEITAS: o que o Watson PERGUNTA (≠ do que ele AFIRMA) ─────────
// A separação é a decisão central do agente. Confirmada tem PROVA (mesmo
// milissegundo, ou origens diferentes); suspeita é só coincidência — e a
// coincidência, medida na base, é legítima na maioria das vezes.
console.log('── 7. suspeitas separadas das confirmadas ──');
{
  const { ehSuspeita, analisar, ehDuplicata: ehDup } = require('../src/services/duplicadas');

  // Mesmo valor + carteira + descrição, 1 dia de diferença, AMBAS do banco com
  // horas distintas → não é prova de nada, mas merece ser perguntado.
  const a = tx({ id: 's1', valor: 17.8, observacao: 'PADARIA SP', data: '2026-08-01T09:00:00.000+00:00', of_tx_id: 'x1' });
  const b = tx({ id: 's2', valor: 17.8, observacao: 'PADARIA SP', data: '2026-08-02T15:30:00.000+00:00', of_tx_id: 'x2' });
  ok(ehSuspeita(a, b) === 'mesmo-valor-e-descricao', 'mesmo valor+descrição em 1 dia é SUSPEITA');
  ok(ehDup(a, b) === null, '…mas NÃO é duplicata confirmada (o banco disse que são duas)');

  // Descrição diferente não vira suspeita — senão vira "mesmo valor no dia",
  // que em conta movimentada acusa qualquer coisa.
  const c = tx({ id: 's3', valor: 17.8, observacao: 'MERCADO', data: '2026-08-01T10:00:00.000+00:00', of_tx_id: 'x3' });
  ok(ehSuspeita(a, c) === null, 'descrição diferente NÃO é suspeita');

  // Mais de 1 dia também não.
  const d = tx({ id: 's4', valor: 17.8, observacao: 'PADARIA SP', data: '2026-08-05T10:00:00.000+00:00', of_tx_id: 'x4' });
  ok(ehSuspeita(a, d) === null, '4 dias de diferença NÃO é suspeita');

  // ⚠️ O invariante que mais importa: nada aparece nas DUAS listas.
  const dupA = tx({ id: 'd1', valor: 56.66, observacao: 'CHINOCA', data: '2026-07-10T18:48:00.324+00:00' });
  const dupB = tx({ id: 'd2', valor: 56.66, observacao: 'CHINOCA', data: '2026-07-10T18:48:00.324+00:00' });
  const r = analisar([a, b, dupA, dupB, c, d]);
  ok(r.confirmadas.length === 1, 'a do mesmo instante entra em confirmadas');
  ok(r.suspeitas.length === 1, 'a da padaria entra em suspeitas');

  const idsConf = new Set(r.confirmadas.flatMap((g) => g.transacoes.map((t) => t.id)));
  const idsSusp = new Set(r.suspeitas.flatMap((g) => g.transacoes.map((t) => t.id)));
  const cruzou = [...idsConf].filter((i) => idsSusp.has(i));
  ok(cruzou.length === 0, `transação não pode estar nas duas listas (cruzou: ${cruzou.join(',')})`);

  // Parcela/recorrente/transferência continuam fora dos DOIS lados.
  const p1 = tx({ id: 'p1', valor: 99, observacao: 'CURSO', parcela_total: 3, data: '2026-08-01T10:00:00Z' });
  const p2 = tx({ id: 'p2', valor: 99, observacao: 'CURSO', parcela_total: 3, data: '2026-08-02T10:00:00Z' });
  const r2 = analisar([p1, p2]);
  ok(r2.confirmadas.length === 0 && r2.suspeitas.length === 0, 'parcela não entra em nenhuma das listas');

  // O aviso proativo do WhatsApp NÃO pode passar a falar de suspeita: é o que
  // transformaria o Watson em agente que grita lobo.
  ok(acharDuplicadas([a, b]).length === 0, 'acharDuplicadas (usado no aviso) ignora suspeitas');
}
console.log('  ok');

// ── 8. Gatilho do WhatsApp ──────────────────────────────────────────────
// O risco aqui é o CONTRÁRIO do detector: pegar frase demais. "Paguei duas
// vezes o aluguel" é um RELATO — virar investigação seria a Sora ignorando o
// que a pessoa disse.
console.log('── 8. gatilho do WhatsApp ──');
{
  const { ehPedidoDuplicadas, pediuFatura } = require('../src/handlers/duplicadas');

  const pega = [
    'tem alguma duplicada?', 'watson', 'chama o watson',
    'tem lançamento repetido?', 'confere se tem transação duplicada',
    'acho que tem compra em dobro', 'verifica duplicadas na fatura',
    'tem algo duplicado?', 'olha se tem cobrança repetida',
  ];
  for (const f of pega) ok(ehPedidoDuplicadas(f) === true, `deveria disparar: "${f}"`);

  const ignora = [
    'paguei duas vezes o aluguel',      // relato, não pedido
    'gastei 50 no mercado',
    'quanto gastei esse mês?',
    'me manda o resumo',
    'comprei duas pizzas',
    'transferi 2 vezes pro joão hoje de manhã e queria saber se deu certo o segundo',  // longa demais
  ];
  for (const f of ignora) ok(ehPedidoDuplicadas(f) === false, `NÃO deveria disparar: "${f}"`);

  ok(pediuFatura('tem duplicada na fatura?') === true, 'escopo de fatura reconhecido');
  ok(pediuFatura('tem duplicada?') === false, 'sem "fatura" o escopo é geral');
}
console.log('  ok');

// ── 9. Manual × banco vale pra TRANSFERÊNCIA e RECEBIMENTO ──────────────
// Caso real: cliente importou o extrato em OFX no dia 10 e conectou o Open
// Finance no dia 11. O banco trouxe os MESMOS lançamentos → 9 duplicatas.
// O agente pegava só 1, porque pagamento de fatura e transferência recebida
// caíam fora do filtro de "consumo".
console.log('── 9. manual × banco em transferência/recebimento ──');
{
  const { analisar } = require('../src/services/duplicadas');

  // Pagamento de fatura (Gasto + transferencia) importado 2×, mesma carteira.
  const fatA = tx({ id: 'f1', tipo: 'Gasto', valor: 70, transferencia: true, categoria: 'Fatura',
    observacao: 'Pagamento de fatura', carteira_nome: 'Banco', data: '2026-06-09T08:22:40.826+00:00' });
  const fatB = tx({ id: 'f2', tipo: 'Gasto', valor: 70, transferencia: true, categoria: 'Fatura',
    observacao: 'Pagamento de fatura', carteira_nome: 'Banco', data: '2026-06-09T08:22:40.826+00:00',
    of_tx_id: 'of-1' });
  ok(ehDuplicata(fatA, fatB) === 'manual-e-banco', 'pagamento de fatura duplicado É acusado');

  // Recebimento importado 2× (o filtro antigo exigia tipo === 'Gasto').
  const recA = tx({ id: 'r1', tipo: 'Recebimento', valor: 2216.87, transferencia: false,
    observacao: 'Transferência Recebida', carteira_nome: 'Banco', data: '2026-07-24T09:37:20.867+00:00' });
  const recB = tx({ id: 'r2', tipo: 'Recebimento', valor: 2216.87, transferencia: false,
    observacao: 'Transferência Recebida', carteira_nome: 'Banco', data: '2026-07-24T09:37:20.867+00:00',
    of_tx_id: 'of-2' });
  ok(ehDuplicata(recA, recB) === 'manual-e-banco', 'recebimento duplicado É acusado');

  // ⚠️⚠️ O CASO QUE NÃO PODE REGREDIR NUNCA ⚠️⚠️
  // O Open Finance traz a quitação da fatura pelas DUAS PONTAS, e isso é
  // CORRETO. Medido na conta real (R$ 70,00 em 09/06):
  //   Gasto       R$70 carteira "Banco"    "Pagamento de fatura"
  //   Recebimento R$70 carteira "platinum" "Pagamento recebido"
  // Mesmo valor, MESMO INSTANTE. Acusar isso mandaria o usuário apagar metade
  // de uma quitação legítima e deixaria o cartão com a fatura eterna em aberto.
  const pernaConta  = tx({ id: 'p1', tipo: 'Gasto', valor: 70, transferencia: true,
    observacao: 'Pagamento de fatura', carteira_nome: 'Banco',
    data: '2026-06-09T08:22:40.826+00:00', of_tx_id: 'of-a' });
  const pernaCartao = tx({ id: 'p2', tipo: 'Recebimento', valor: 70, transferencia: true,
    observacao: 'Pagamento recebido', carteira_nome: 'platinum',
    data: '2026-06-09T08:22:40.975+00:00', of_tx_id: 'of-b' });
  ok(ehDuplicata(pernaConta, pernaCartao) === null,
    '⚠️ as DUAS PERNAS da fatura (conta paga × cartão recebe) NUNCA são duplicata');

  // As travas, uma a uma — se qualquer uma cair, a de cima volta a falhar.
  ok(ehDuplicata(pernaConta, { ...pernaCartao, carteira_nome: 'Banco' }) === null,
    'mesma carteira mas TIPO diferente → não casa (trava do tipo)');
  ok(ehDuplicata(pernaConta, { ...pernaCartao, tipo: 'Gasto' }) === null,
    'mesmo tipo mas CARTEIRA diferente → não casa (trava da carteira)');

  // O par legítimo não pode nem virar suspeita.
  const r = analisar([pernaConta, pernaCartao]);
  ok(r.confirmadas.length === 0 && r.suspeitas.length === 0,
    'as duas pernas não aparecem nem como suspeita');

  // Parcela e recorrência seguem fora, mesmo com a regra mais ampla.
  ok(ehDuplicata(
    tx({ id: 'x1', transferencia: true, parcela_total: 12 }),
    tx({ id: 'x2', transferencia: true, parcela_total: 12, of_tx_id: 'of-x' })) === null,
    'parcela continua fora mesmo em transferência');

  // Duas transferências REAIS do banco (ambas OF) não são duplicata: a origem
  // é a mesma, então não há prova nenhuma.
  ok(ehDuplicata(
    tx({ id: 'y1', tipo: 'Recebimento', valor: 50, of_tx_id: 'of-y1', data: '2026-08-01T10:00:00Z' }),
    tx({ id: 'y2', tipo: 'Recebimento', valor: 50, of_tx_id: 'of-y2', data: '2026-08-01T15:00:00Z' })) === null,
    'duas do banco (OF+OF) não são duplicata — sem origem diferente, sem prova');
}
console.log('  ok');

// ── Resultado ────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ duplicadas: todos os casos passaram');
