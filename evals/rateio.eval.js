// =============================================================================
// eval:rateio — trava a divisão de um lançamento por categoria.
//
// O que este eval protege, em ordem de gravidade:
//   1. a soma das partes é EXATAMENTE o valor original (em centavos);
//   2. nada que quebraria outra parte do sistema é aceito (parcelada, moeda
//      estrangeira, transferência);
//   3. as chaves de dedup (`of_tx_id`, `fitid`, `pluggy_tx_id`) ficam em UMA
//      parte só — duas linhas com o mesmo of_tx_id derrubam o sync;
//   4. o que define "a mesma compra" (data, conta, tipo, pago, fatura) é
//      copiado igual em todas as partes.
// =============================================================================
const {
  montarRateio, montarDesfazer, motivoRecusa, validarPartes, CHAVES_DE_ORIGEM,
} = require('../src/services/rateio');

let falhas = 0;
function ok(cond, nome, extra) {
  if (cond) { console.log(`  ok ${nome}`); return; }
  falhas++; console.log(`  XX ${nome}${extra ? ` — ${extra}` : ''}`);
}
const eq = (a, b, nome) => ok(a === b, nome, `veio ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`);

const TX = {
  id: 'tx-1', grupo_id: 'g1', criado_por: 'u1', tipo: 'Gasto', categoria: 'Supermercado',
  valor: 300, observacao: 'SUPERMERCADO BOM DIA', carteira_nome: 'Nubank',
  data: '2026-09-01T00:00:00+00:00', pago: true, transferencia: false,
  of_tx_id: 'of-abc', fitid: null, pluggy_tx_id: null,
  of_bill_id: 'bill-9', of_bill_post_date: '2026-09-02', ignorar_em: null,
  parcela_total: null, moeda: null,
};

console.log('── 1. o caso do cliente: R$ 300 em limpeza + alimentação ──');
{
  const r = montarRateio(TX, [
    { categoria: 'Alimentação', valor: 200 },
    { categoria: 'Casa', valor: 100 },
  ], 'grp-1');
  ok(!r.erro, 'aceita', r.erro);
  eq(r.linhas.length, 2, 'gera 2 linhas');
  eq(r.linhas.reduce((s, l) => s + l.valor, 0), 300, 'a soma continua R$ 300 — o painel inteiro depende disto');
  eq(r.linhas[0].categoria, 'Alimentação', 'categoria da 1ª');
  eq(r.linhas[1].categoria, 'Casa', 'categoria da 2ª');
}

console.log('\n── 2. a soma tem de FECHAR (em centavos) ──');
{
  ok(!!montarRateio(TX, [{ categoria: 'A', valor: 200 }, { categoria: 'B', valor: 99 }]).erro,
    'recusa quando falta 1 real');
  ok(!!montarRateio(TX, [{ categoria: 'A', valor: 200 }, { categoria: 'B', valor: 101 }]).erro,
    'recusa quando sobra 1 real');
  ok(!!montarRateio(TX, [{ categoria: 'A', valor: 299.99 }, { categoria: 'B', valor: 0.02 }]).erro,
    'recusa por 1 centavo');
  // ⚠️ Float puro reprovaria esta: 0.1+0.2 = 0.30000000000000004.
  const centavo = { ...TX, valor: 0.3 };
  ok(!montarRateio(centavo, [{ categoria: 'A', valor: 0.1 }, { categoria: 'B', valor: 0.2 }]).erro,
    '0,10 + 0,20 = 0,30 é aceito (soma em centavos, não em float)');
  const tresPartes = montarRateio({ ...TX, valor: 100 }, [
    { categoria: 'A', valor: 33.33 }, { categoria: 'B', valor: 33.33 }, { categoria: 'C', valor: 33.34 },
  ]);
  ok(!tresPartes.erro, 'divisão em 3 com centavo de sobra na última');
}

console.log('\n── 3. o que NÃO pode ser rateado ──');
{
  ok(!!motivoRecusa({ ...TX, parcela_total: 3, parcela_num: 1 }),
    'PARCELADA recusada — dividir quebraria o casamento com a fatura do banco');
  ok(!!motivoRecusa({ ...TX, moeda: 'USD', valor_moeda: 55 }), 'moeda estrangeira recusada');
  ok(!!motivoRecusa({ ...TX, transferencia: true }), 'transferência/pagamento de fatura recusado');
  ok(!!motivoRecusa({ ...TX, valor: 0 }), 'valor zero recusado');
  ok(!!motivoRecusa(null), 'transação inexistente recusada');
  ok(!motivoRecusa(TX), 'gasto comum é aceito');
  ok(!motivoRecusa({ ...TX, parcela_total: 1 }), 'parcela_total = 1 (compra à vista) é aceito');
}

console.log('\n── 4. partes inválidas ──');
{
  ok(!!validarPartes(TX, [{ categoria: 'A', valor: 300 }]), 'uma parte só não é rateio');
  ok(!!validarPartes(TX, []), 'lista vazia recusada');
  ok(!!validarPartes(TX, [{ categoria: '', valor: 150 }, { categoria: 'B', valor: 150 }]),
    'parte sem categoria recusada');
  ok(!!validarPartes(TX, [{ categoria: 'A', valor: 0 }, { categoria: 'B', valor: 300 }]),
    'parte com valor zero recusada');
  ok(!!validarPartes(TX, [{ categoria: 'A', valor: -50 }, { categoria: 'B', valor: 350 }]),
    'parte negativa recusada');
  ok(!!validarPartes(TX, Array.from({ length: 21 }, () => ({ categoria: 'A', valor: 1 }))),
    'mais de 20 partes recusado');
}

console.log('\n── 5. chaves de dedup ficam em UMA parte só ──');
{
  const tx = { ...TX, of_tx_id: 'of-abc', fitid: 'fit-1', pluggy_tx_id: 'pg-1' };
  const r = montarRateio(tx, [
    { categoria: 'A', valor: 100 }, { categoria: 'B', valor: 100 }, { categoria: 'C', valor: 100 },
  ], 'grp');
  for (const chave of CHAVES_DE_ORIGEM) {
    const comChave = r.linhas.filter((l) => l[chave] != null).length;
    ok(comChave <= 1, `${chave} em no máximo 1 parte`, `apareceu em ${comChave}`);
  }
  eq(r.linhas[0].of_tx_id, 'of-abc', 'a 1ª parte herda o of_tx_id');
  eq(r.linhas[1].of_tx_id, undefined, 'a 2ª NÃO herda — duas linhas com o mesmo of_tx_id derrubam o sync');
}

console.log('\n── 6. o que define "a mesma compra" é copiado igual ──');
{
  const r = montarRateio(TX, [{ categoria: 'A', valor: 150 }, { categoria: 'B', valor: 150 }], 'grp');
  for (const campo of ['grupo_id', 'tipo', 'carteira_nome', 'data', 'pago', 'of_bill_id', 'of_bill_post_date']) {
    ok(r.linhas.every((l) => l[campo] === TX[campo]), `${campo} igual em todas as partes`);
  }
  ok(r.linhas.every((l) => l.rateio_grupo === 'grp'), 'todas carregam o mesmo rateio_grupo');
  ok(r.linhas.every((l) => l.id_curto && l.id_curto.length === 6), 'cada parte tem id_curto próprio');
  ok(new Set(r.linhas.map((l) => l.id_curto)).size === 2, 'os id_curto são diferentes entre si');
  ok(r.linhas.every((l) => l.observacao === TX.observacao), 'herda a descrição quando a parte não traz uma');
  ok(!('id' in r.linhas[0]), 'não carrega o id da transação original');
  ok(!('categoria' in TX) || r.linhas[0].categoria !== TX.categoria, 'a categoria original não sobrevive');
}

console.log('\n── 7. descrição por parte ──');
{
  const r = montarRateio(TX, [
    { categoria: 'Alimentação', valor: 200, observacao: 'Compras do mês' },
    { categoria: 'Casa', valor: 100 },
  ]);
  eq(r.linhas[0].observacao, 'Compras do mês', 'usa a descrição da parte quando existe');
  eq(r.linhas[1].observacao, TX.observacao, 'cai na do original quando não existe');
}


// ═══════════════════════════════════════════════════════════════════════════
// DESFAZER — "voltar ao normal"
//
// O que estes casos protegem:
//   1. a categoria ORIGINAL volta (é pra isso que existe `rateio_origem`);
//   2. o desfazer é NEUTRO NO SALDO — e por isso RECUSA quando as partes
//      divergem em conta/tipo/pago/transferência;
//   3. o valor é a soma de HOJE, não a de antes: editar uma parte já ajustou o
//      saldo, e restaurar o valor velho deixaria a carteira errada;
//   4. as chaves de dedup voltam pra linha unificada — sem elas o sync do Open
//      Finance REIMPORTA a transação e duplica.
// ═══════════════════════════════════════════════════════════════════════════

const ORIGEM = { categoria: 'Supermercado', id_curto: 'ORIG01', valor: 300 };
const parte = (o) => ({
  id: o.id, grupo_id: 'g1', criado_por: 'u1', tipo: 'Gasto', carteira_nome: 'Nubank',
  data: '2026-09-01', pago: true, transferencia: false,
  created_at: o.created_at || '2026-09-01T10:00:00Z',
  categoria: o.categoria, valor: o.valor, observacao: o.observacao ?? 'Supermercado',
  rateio_grupo: 'grp', rateio_origem: o.origem === null ? null : ORIGEM,
  ...(o.extra || {}),
});

console.log('\n── 8. desfazer devolve a categoria e o codigo originais ──');
{
  const r = montarDesfazer([
    parte({ id: 'a', categoria: 'Alimentação', valor: 200, created_at: '2026-09-01T10:00:00Z' }),
    parte({ id: 'b', categoria: 'Casa', valor: 100, created_at: '2026-09-01T10:00:01Z' }),
  ]);
  ok(!r.erro, 'nao recusa o caso normal');
  eq(r.linha.categoria, 'Supermercado', 'volta a categoria ORIGINAL, nao a de uma parte');
  eq(r.linha.id_curto, 'ORIG01', 'volta o id_curto original (o codigo usado no zap)');
  eq(r.linha.valor, 300, 'valor = soma das partes');
  eq(r.linha.rateio_grupo, null, 'a linha unificada nao fica marcada como rateada');
  eq(r.linha.rateio_origem, null, 'nem carrega a origem adiante');
  eq(r.ids.length, 2, 'devolve os ids das partes a apagar');
  eq(r.aviso, null, 'sem aviso quando nada mudou');
  ok(!('id' in r.linha), 'nao carrega id de nenhuma parte');
}

console.log('\n── 9. RECUSA quando juntar mudaria o saldo ──');
{
  const casos = [['carteira_nome', 'Itaú'], ['tipo', 'Recebimento'], ['pago', false], ['transferencia', true]];
  for (const [campo, v] of casos) {
    const r = montarDesfazer([
      parte({ id: 'a', categoria: 'Alimentação', valor: 200 }),
      parte({ id: 'b', categoria: 'Casa', valor: 100, extra: { [campo]: v } }),
    ]);
    ok(!!r.erro, `recusa quando ${campo} diverge entre as partes`);
    ok(!r.linha, `e nao devolve linha quando ${campo} diverge`);
  }
}

console.log('\n── 10. divergencia que NAO mexe em saldo passa ──');
{
  const r = montarDesfazer([
    parte({ id: 'a', categoria: 'Alimentação', valor: 200, extra: { data: '2026-09-05' } }),
    parte({ id: 'b', categoria: 'Casa', valor: 100 }),
  ]);
  ok(!r.erro, 'data diferente entre as partes NAO impede o desfazer');
}

console.log('\n── 11. parte editada: vale o valor de HOJE ──');
{
  const r = montarDesfazer([
    parte({ id: 'a', categoria: 'Alimentação', valor: 250 }),   // era 200
    parte({ id: 'b', categoria: 'Casa', valor: 100 }),
  ]);
  eq(r.linha.valor, 350, 'soma o que existe hoje, nao os 300 de origem');
  ok(/valor mudou/i.test(r.aviso || ''), 'avisa que o total mudou desde a divisao');
  ok(!r.erro, 'mas NAO recusa — a edicao foi de proposito e o saldo ja a refletiu');
}

console.log('\n── 12. uma parte so ainda e desfazivel ──');
{
  const r = montarDesfazer([parte({ id: 'a', categoria: 'Alimentação', valor: 200 })]);
  ok(!r.erro, 'nao recusa com uma parte so (o usuario pode ter apagado as outras)');
  eq(r.linha.categoria, 'Supermercado', 'devolve a categoria original mesmo assim');
  eq(r.linha.valor, 200, 'valor = o que sobrou');
}

console.log('\n── 13. sem rateio_origem (152 nao rodou): cai na MAIOR parte ──');
{
  const r = montarDesfazer([
    parte({ id: 'a', categoria: 'Alimentação', valor: 200, origem: null }),
    parte({ id: 'b', categoria: 'Casa', valor: 100, origem: null }),
  ]);
  ok(!r.erro, 'ainda funciona sem a coluna');
  eq(r.linha.categoria, 'Alimentação', 'usa a categoria da parte de MAIOR valor');
  ok(/maior parte/i.test(r.aviso || ''), 'e avisa que foi palpite, nao a original');
}

console.log('\n── 14. as chaves de dedup VOLTAM pra linha unificada ──');
{
  const r = montarDesfazer([
    parte({ id: 'a', categoria: 'Alimentação', valor: 200, extra: { of_tx_id: 'of-abc' } }),
    parte({ id: 'b', categoria: 'Casa', valor: 100 }),
  ]);
  eq(r.linha.of_tx_id, 'of-abc', 'of_tx_id volta — sem ele o sync REIMPORTA e duplica');
}
{
  // A parte que tinha a chave foi apagada: nao ha o que restaurar, e a linha
  // NAO pode inventar uma chave.
  const r = montarDesfazer([parte({ id: 'b', categoria: 'Casa', valor: 100 })]);
  ok(r.linha.of_tx_id === undefined, 'nao inventa chave de dedup quando nenhuma parte tem');
}

console.log('\n── 15. entrada vazia nao explode ──');
{
  ok(!!montarDesfazer([]).erro, 'lista vazia vira erro explicado');
  ok(!!montarDesfazer(null).erro, 'null vira erro explicado');
}

console.log(falhas ? `\n✗ ${falhas} falha(s)` : '\n✓ rateio: todos os casos passaram');
process.exit(falhas ? 1 : 0);
