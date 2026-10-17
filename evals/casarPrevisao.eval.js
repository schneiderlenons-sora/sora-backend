// =============================================================================
// EVAL do casamento PREVISÃO × COBRANÇA DO BANCO.
//
// ⚠️ O QUE ESTE EVAL PROTEGE não é "achar o casamento" — é NÃO QUITAR A ERRADA.
// Uma previsão que fica sem baixa custa um toque ao usuário. Uma previsão
// quitada por engano corrompe o saldo projetado e a pessoa não tem como
// desconfiar: a linha simplesmente some, com ✓, como se estivesse tudo certo.
//
// Por isso a maior parte das asserções abaixo testa o que ele NÃO pode fazer
// sozinho, não o que ele acerta.
//
// Rodar:  npm run eval:casar-previsao
// =============================================================================
const { casar } = require('../src/services/casarPrevisao');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

const PREV = {
  recorrencia_id: 'r1', competencia: '2026-09', vencimento: '2026-09-10',
  valor: 1700, carteira: 'Inter', tipo: 'Gasto',
};
const tx = (o) => ({ id: 't1', data: '2026-09-10', valor: 1700, tipo: 'Gasto',
  carteira_nome: 'Inter', of_tx_id: 'of-1', recorrencia_id: null, ...o });

// ── 1. Caso limpo: casa e pode ser automático ───────────────────────────────
console.log('── 1. o caso limpo ──');
{
  const r = casar([PREV], [tx()]);
  eq(r.length, 1, 'acha a cobrança');
  eq(r[0].automatico, true, 'e o caso limpo pode ser automático');
  eq(r[0].transacao_id, 't1', 'aponta a transação certa');
}
console.log('  ok');

// ── 2. Pagamento ADIANTADO e ATRASADO — o caso do cliente ──────────────────
//
// "Se eu antecipo o pagamento, não consigo dar baixa naquele valor previsto."
console.log('── 2. adiantado e atrasado ──');
{
  eq(casar([PREV], [tx({ data: '2026-09-08' })]).length, 1, 'pago 2 dias ANTES casa');
  eq(casar([PREV], [tx({ data: '2026-09-14' })]).length, 1, 'pago 4 dias DEPOIS casa');
  eq(casar([PREV], [tx({ data: '2026-09-30' })]).length, 0, 'pago 20 dias depois NÃO casa');
}
console.log('  ok');

// ── 3. AMBIGUIDADE nunca vira baixa automática ─────────────────────────────
//
// ⚠️ Esta é a asserção mais importante do arquivo. É o cenário que o dono do
// produto levantou: duas contas de valor parecido na mesma semana.
console.log('── 3. ambiguidade derruba o automático ──');
{
  // duas previsões disputando a MESMA cobrança
  const p2 = { ...PREV, recorrencia_id: 'r2' };
  const r = casar([PREV, p2], [tx()]);
  eq(r.length, 2, 'as duas previsões acham a cobrança');
  eq(r.every((x) => x.automatico === false), true,
    'mas NENHUMA pode ser automática — duas previsões disputam a mesma cobrança');

  // duas cobranças parecidas para a MESMA previsão
  const r2 = casar([PREV], [tx(), tx({ id: 't2', of_tx_id: 'of-2', data: '2026-09-11' })]);
  eq(r2[0].automatico, false, 'duas cobranças na janela também derrubam o automático');
  eq(r2[0].transacao_id, 't1', 'e sugere a MAIS PRÓXIMA do vencimento');
}
console.log('  ok');

// ── 4. Conta de VALOR VARIÁVEL nunca é automática ──────────────────────────
//
// ⚠️ O valor é o sinal FORTE do casamento. Numa conta que varia ele não existe,
// então a confirmação humana é obrigatória — mesmo com a chave global ligada.
console.log('── 4. valor variável só sugere ──');
{
  const luz = { ...PREV, recorrencia_id: 'r9', valor: 200, valor_variavel: true };
  const r = casar([luz], [tx({ valor: 200.5, of_tx_id: 'of-9' })]);
  eq(r.length, 1, 'ainda SUGERE (o usuário confirma)');
  eq(r[0].automatico, false, 'mas nunca quita sozinha');
  eq(r[0].motivo, 'o valor desta conta costuma variar', 'e diz por quê');
}
console.log('  ok');

// ── 5. O que NÃO é candidato ───────────────────────────────────────────────
console.log('── 5. fora do casamento ──');
{
  eq(casar([PREV], [tx({ carteira_nome: 'Nubank' })]).length, 0, 'carteira diferente não casa');
  eq(casar([PREV], [tx({ valor: 1700.90 })]).length, 1, 'dentro de R$ 1,00 casa');
  eq(casar([PREV], [tx({ valor: 5000 })]).length, 0, 'fora até da banda larga (30%) não casa');
  eq(casar([PREV], [tx({ of_tx_id: null })]).length, 0, 'transação MANUAL não entra (só cobrança do banco)');
  eq(casar([PREV], [tx({ recorrencia_id: 'rX' })]).length, 0, 'transação já amarrada não entra de novo');
  eq(casar([PREV], [tx({ tipo: 'Recebimento' })]).length, 0, 'tipo diferente não casa');
  eq(casar([{ ...PREV, carteira: null }], [tx()]).length, 0,
    'previsão SEM carteira não casa com nada — "quase certo" aqui vale zero');
}
console.log('  ok');

// ── 6. Carteira com acento/caixa diferente ainda casa ──────────────────────
//
// O resto da base compara carteira por `ilike`; comparar cru aqui faria
// "Cartão Inter" e "cartao inter" passarem por contas diferentes.
console.log('── 6. carteira normalizada ──');
{
  const p = { ...PREV, carteira: 'Conta Corrente' };
  eq(casar([p], [tx({ carteira_nome: 'conta corrente' })]).length, 1, 'ignora caixa');
  eq(casar([{ ...PREV, carteira: 'Cartão' }], [tx({ carteira_nome: 'cartao' })]).length, 1, 'ignora acento');
}
console.log('  ok');

// ── 7. BANDA LARGA — a conta fixa que balança sem ser "variável" (set/2026) ─
//
// Relato real: Internet prevista R$169,90, veio do banco R$177,53 (plano
// reajustou). A banda apertada (±R$1) não acha nada; a larga (30%) acha —
// mas NUNCA automática, mesmo sem a recorrência estar marcada valor_variavel.
console.log('── 7. banda larga (conta fixa que balança) ──');
{
  const internet = { ...PREV, recorrencia_id: 'rI', valor: 169.90, valor_variavel: false };
  const r = casar([internet], [tx({ valor: 177.53, of_tx_id: 'of-internet' })]);
  eq(r.length, 1, 'a banda larga ACHA (era o que faltava pro cliente)');
  eq(r[0].automatico, false, 'mas NUNCA automática — só sugestão, mesmo sem valor_variavel');
  eq(r[0].motivo, 'o valor veio um pouco diferente do previsto', 'e diz por quê');

  // fora até da banda larga
  eq(casar([internet], [tx({ valor: 400, of_tx_id: 'of-longe' })]).length, 0,
    'mas fora dos 30% continua sem casar — a folga não é infinita');

  // ⚠️ SÓ tenta a banda larga quando a apertada não achou NADA. Se já achou
  // dentro da apertada, não busca mais candidatos — evita trazer ambiguidade
  // que não existia.
  const dupla = casar([internet], [
    tx({ id: 'tx-certo', valor: 169.90, of_tx_id: 'of-certo' }),          // dentro da apertada
    tx({ id: 'tx-parecido', valor: 177.53, of_tx_id: 'of-parecido', data: '2026-09-11' }), // só da larga
  ]);
  eq(dupla.length, 1, 'achou na apertada, não mistura com a larga');
  eq(dupla[0].transacao_id, 'tx-certo', 'e é a certa');
  eq(dupla[0].automatico, true, 'automática — a larga nem entrou em jogo');

  // valor_variavel + banda larga: continua não automática (o mesmo já valia
  // pra variável sozinho — aqui os dois motivos coexistem, o que importa é
  // que automatico continua false).
  const luzLarga = { ...PREV, recorrencia_id: 'rL', valor: 100, valor_variavel: true };
  const rl = casar([luzLarga], [tx({ valor: 104, of_tx_id: 'of-luz' })]);
  eq(rl[0].automatico, false, 'variável + banda larga: continua não automática');
}
console.log('  ok');

// ── 8. Os casos REAIS da 1ª medição (out/2026) ─────────────────────────────
// A consulta das contas fixas falhava desde 11/09 (coluna `ativo`), então a
// banda larga nunca tinha rodado de verdade. Corrigida, ela errava assim —
// cada linha abaixo é um par medido na base.
console.log('── 8. casos reais (banda larga com nome) ──');
{
  const P = (descricao, valor, venc = '2026-10-12') => ({ recorrencia_id: 'r-' + descricao, competencia: '2026-10',
    vencimento: venc, valor, carteira: 'BTG', tipo: 'Gasto', descricao });
  const T = (id, observacao, valor, data = '2026-10-14') => ({ id, data, valor, tipo: 'Gasto',
    carteira_nome: 'BTG', of_tx_id: 'of-' + id, recorrencia_id: null, observacao });

  // ⚠️ o que NÃO pode ser sugerido
  eq(casar([P('Lovable', 27.49)], [T('a', 'Lumberjack Barbearia', 35)]).length, 0, 'Lovable × barbearia (27%): nada');
  eq(casar([P('Spotify', 23.6)], [T('b', 'MERCADOLIVRE*MERC', 21.93)]).length, 0, 'Spotify × Mercado Livre (7%, sem nome): nada');
  eq(casar([P('Academia', 100)], [T('c', 'Cancelamento de liberação de d', 86.44)]).length, 0, 'Academia × cancelamento (13,6%): nada');
  eq(casar([P('Internet', 169.9, '2026-10-20')], [T('d', 'Fit Energia', 195.86, '2026-10-16')]).length, 0,
    'Internet × conta de energia (15,3%): nada');

  // ⚠️ a Luz escolhe a ENERGIA (valor mais próximo), não o supermercado nem a farmácia
  {
    const r = casar([P('Luz', 191.77)], [
      T('angeloni', 'ANGELONI SUPER LOJA 21', 135.8, '2026-10-14'),
      T('raia', 'RAIA DROGASIL SA', 172.79, '2026-10-15'),
      T('fit', 'Fit Energia', 195.86, '2026-10-16'),
    ]);
    eq(r.length, 1, 'Luz: acha uma sugestão');
    eq(r[0] && r[0].transacao_id, 'fit', 'Luz: é a Fit Energia (2,1%), não o supermercado nem a farmácia');
    eq(r[0] && r[0].automatico, false, 'Luz: só sugestão');
  }

  // o que DEVE ser sugerido
  eq(casar([P('Empresa Funeraria Santa Cruz', 85.41, '2026-10-15')], [T('f', 'Empresa Funeraria Santa Cruz', 87.18, '2026-10-16')]).length, 1,
    'Funerária 85,41 × 87,18 (2%, mesmo nome): sugere');
  eq(casar([{ ...P('Jeniffer', 328), tipo: 'Recebimento' }], [{ ...T('j', 'Pix recebido Jeniffer Layne da', 365), tipo: 'Recebimento' }]).length, 1,
    'Jeniffer 328 × "Pix recebido Jeniffer" 365 (11%, nome bate): sugere');
  eq(casar([P('Condomínio', 550, '2026-10-15')], [T('k', 'CONDOMINIO LE PETIT ART VILLAG', 529.19, '2026-10-16')]).length, 1,
    'Condomínio × "CONDOMINIO LE PETIT" (3,8%): sugere');
  eq(casar([P('Internet', 169.9, '2026-09-20')], [T('m', 'MP*MP', 177.53, '2026-09-18')]).length, 1,
    'o reajuste que motivou a banda (Internet × MP*MP, 4,5%, sem nome): continua sugerindo');

  // ⚠️ CATEGORIA: o único sinal que separa estes dois (valor nenhum separa)
  {
    const net = { ...P('Internet', 169.9, '2026-10-16'), categoria: 'Internet' };
    eq(casar([net], [{ ...T('raia', 'RAIA DROGASIL SA', 172.79, '2026-10-15'), categoria: 'Farmácia' }]).length, 0,
      'Internet [Internet] × farmácia [Farmácia] a 1,7%: categorias em conflito → nada');
    eq(casar([{ ...net, vencimento: '2026-09-20' }], [{ ...T('mp', 'MP*MP', 177.53, '2026-09-18'), categoria: 'Internet' }]).length, 1,
      'Internet × MP*MP [Internet]: mesma categoria → sugere');
    eq(casar([{ ...P('Luz', 191.77), categoria: 'Outros' }], [{ ...T('fit', 'Fit Energia', 195.86, '2026-10-16'), categoria: '⚡ Conta de Luz' }]).length, 1,
      'Luz [Outros] × Fit Energia [Conta de Luz]: categoria genérica não atrapalha');
    // categoria igual + banda larga além de 5% (sem nome): sugere
    eq(casar([{ ...P('Plano', 200), categoria: 'Saúde' }], [{ ...T('s', 'UNIMED ANGEL', 225), categoria: '🏥 Saúde' }]).length, 1,
      'mesma categoria (ignorando emoji/acento) a 12,5%: sugere');
    // categoria igual na banda apertada (sem valor exato nem nome): automático
    const r = casar([{ ...P('Plano', 200), categoria: 'Saúde' }], [{ ...T('s2', 'UNIMED ANGEL', 200.5), categoria: 'Saúde' }]);
    eq(r[0] && r[0].automatico, true, 'apertada + mesma categoria: automático');
    // conflito de categoria barra até na banda APERTADA (o caso medido)
    eq(casar([{ ...P('Dentista', 160, '2026-10-01'), categoria: 'Dentista' }],
      [{ ...T('polp3', 'POLP TECNOLOGIA LTDA', 159, '2026-09-30'), categoria: 'Educação' }]).length, 0,
      'Dentista [Dentista] × POLP [Educação] a R$ 1: categorias em conflito → nada');
    // o texto pro cliente nunca sai vazio quando não é automático
    const d = casar([P('Dentista', 160, '2026-10-01')], [T('polp2', 'POLP TECNOLOGIA LTDA', 159, '2026-09-30')]);
    eq(typeof (d[0] && d[0].motivo), 'string', 'sugestão não automática sempre explica o porquê');
  }

  // ⚠️ o teto de 15% vale MESMO com nome em comum
  eq(casar([{ ...P('Jeniffer', 328), tipo: 'Recebimento' }], [{ ...T('j2', 'Pix recebido Jeniffer Layne', 410), tipo: 'Recebimento' }]).length, 0,
    'Jeniffer 328 × 410 (25%, nome bate): fora — a banda é 15%');

  // ⚠️ duas candidatas válidas: vence a de VALOR mais próximo, mesmo com data mais longe
  {
    const r = casar([P('Condomínio', 550, '2026-10-15')], [
      T('perto-data', 'CONDOMINIO LE PETIT', 520, '2026-10-15'),   // 5,5%, mesmo dia
      T('perto-valor', 'CONDOMINIO LE PETIT', 548, '2026-10-18'),  // 0,4%, 3 dias depois
    ]);
    eq(r[0] && r[0].transacao_id, 'perto-valor', 'entre duas candidatas, a de valor mais próximo (não a de data)');
  }

  // ⚠️ automático exige valor EXATO ou nome em comum
  {
    const r = casar([P('Dentista', 160, '2026-10-01')], [T('polp', 'POLP TECNOLOGIA LTDA', 159, '2026-09-30')]);
    eq(r.length, 1, 'Dentista 160 × POLP 159: ainda sugere (está a R$ 1)');
    eq(r[0] && r[0].automatico, false, 'mas NÃO é automático (nem exato, nem nome)');
    const r2 = casar([P('Maple Bear Maringa', 2937.84, '2026-10-05')], [T('mb', 'Maple Bear Maringa', 2937.84, '2026-10-05')]);
    eq(r2[0] && r2[0].automatico, true, 'Maple Bear exato e com nome: automático');
    const r3 = casar([P('LP Internet', 99.9, '2026-10-10')], [T('lp', 'Pagamento efetuado', 99.9, '2026-10-09')]);
    eq(r3[0] && r3[0].automatico, true, 'valor exato mesmo sem nome: automático');
    const r4 = casar([P('Netflix', 44.9, '2026-10-03')], [T('nf', 'NETFLIX.COMSAO PAULOBR', 45.5, '2026-10-03')]);
    eq(r4[0] && r4[0].automatico, true, 'nome bate (NETFLIX) a R$ 0,60: automático');
  }
}
console.log('  ok');

// ── 9. A CONSULTA pede colunas que EXISTEM ─────────────────────────────────
// ⚠️ O bug que deixou TUDO isto morto por um mês: o select pedia `ativo` e a
// coluna é `ativa`. Teste de função pura não pega erro de consulta — este
// confere a lista de colunas contra as colunas reais de `recorrencias`
// (lidas da base em 17/10/2026). Coluna nova na consulta? Inclua aqui junto
// com a migration que a cria.
console.log('── 9. colunas da consulta ──');
{
  const REAIS = new Set(['id', 'grupo_id', 'tipo', 'categoria', 'valor', 'dia_vencimento', 'descricao', 'carteira',
    'ativa', 'created_at', 'updated_at', 'criado_por', 'valor_variavel', 'ultimo_previsto_ym', 'modo_lancamento',
    'lembrete', 'ultimo_lembrete_dia', 'frequencia', 'dia_semana', 'mes_vencimento', 'repeticoes', 'data_inicio',
    'data_fim', 'lembrete_dias', 'moeda', 'valor_moeda', 'taxa_brl']);
  const { COLUNAS_RECORRENCIA } = require('../src/services/baixaPrevisao');
  const pedidas = COLUNAS_RECORRENCIA.split(',').map((c) => c.trim());
  const inexistentes = pedidas.filter((c) => !REAIS.has(c));
  eq(inexistentes.join(','), '', 'toda coluna pedida existe na tabela');
  eq(pedidas.includes('ativa'), true, 'e é `ativa`, não `ativo`');
}
console.log('  ok');

// ── Resultado ───────────────────────────────────────────────────────────────
if (falhas.length) {
  console.error(`\n❌ ${falhas.length} falha(s):`);
  for (const f of falhas) console.error('  - ' + f);
  process.exit(1);
}
console.log('\n✅ casamento de previsão: todos os casos passaram');
