// =============================================================================
// EVAL do DRE gerencial (services/dre).
//
// O risco aqui não é dar erro — é dar um número plausível e errado. Um custo
// contado duas vezes, ou uma compra de estoque tratada como despesa, muda o
// lucro que o dono usa pra decidir preço, e nada na tela denuncia.
//
// Rodar:  npm run eval:dre
// =============================================================================
const { montarDre, naturezaDe } = require('../src/services/dre');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };
const eq = (a, b, msg) => ok(a === b, `${msg} (esperado ${b}, veio ${a})`);

// ── 1. Loja física simples: vendeu, pagou aluguel ──────────────────────────
console.log('── 1. loja física ──');
{
  const d = montarDre({
    lancamentos: [
      { tipo: 'entrada', valor: 100000, categoria: 'vendas' },   // R$1.000
      { tipo: 'saida',   valor: 30000,  categoria: 'aluguel' },  // R$300 fixa
      { tipo: 'saida',   valor: 10000,  categoria: 'marketing' },// R$100 variável
    ],
    cmv: 40000, // R$400 de mercadoria vendida
  });
  eq(d.receita_bruta, 100000, 'receita bruta');
  eq(d.receita_liquida, 100000, 'sem taxa nem imposto, líquida = bruta');
  eq(d.lucro_bruto, 60000, 'lucro bruto = líquida − CMV');
  eq(d.margem_bruta_pct, 60, 'margem bruta 60%');
  eq(d.despesas_fixas, 30000, 'aluguel é fixa');
  eq(d.despesas_variaveis, 10000, 'marketing é variável');
  eq(d.lucro_liquido, 20000, 'lucro líquido = 1000 − 400 − 300 − 100');
  eq(d.margem_pct, 20, 'margem líquida 20%');
}
console.log('  ok');

// ── 2. Compra de estoque NÃO é despesa ─────────────────────────────────────
// O erro clássico: o mês em que o dono abastece a loja fica no vermelho e o
// seguinte com margem irreal. Uma saída com compra_id é troca de dinheiro por
// estoque — o resultado só aparece quando vende (via CMV).
console.log('── 2. compra de estoque ──');
{
  const base = [
    { tipo: 'entrada', valor: 100000, categoria: 'vendas' },
    { tipo: 'saida',   valor: 30000,  categoria: 'aluguel' },
  ];
  const semCompra = montarDre({ lancamentos: base, cmv: 40000 });
  const comCompra = montarDre({
    lancamentos: [...base, { tipo: 'saida', valor: 80000, categoria: 'fornecedor', compra_id: 'c1' }],
    cmv: 40000,
  });
  eq(comCompra.lucro_liquido, semCompra.lucro_liquido, 'comprar estoque não muda o lucro do mês');
  eq(comCompra.compras_estoque, 80000, 'a compra aparece separada, pro dono ver o caixa');
  eq(comCompra.despesas_total, 30000, 'a compra fica FORA das despesas');
  // Mas fornecedor SEM compra vinculada (lançamento avulso) conta como despesa:
  const avulso = montarDre({
    lancamentos: [...base, { tipo: 'saida', valor: 80000, categoria: 'fornecedor' }],
    cmv: 40000,
  });
  eq(avulso.despesas_total, 110000, 'saída de fornecedor SEM compra continua despesa');
  eq(avulso.despesas_variaveis, 80000, 'fornecedor avulso é variável');
}
console.log('  ok');

// ── 3. Ponto de equilíbrio ─────────────────────────────────────────────────
console.log('── 3. ponto de equilíbrio ──');
{
  // CMV 40% da receita, sem despesa variável → cada R$1 vendido gera R$0,60 de
  // margem. Com R$300 de custo fixo, empata faturando R$500.
  const d = montarDre({
    lancamentos: [
      { tipo: 'entrada', valor: 100000, categoria: 'vendas' },
      { tipo: 'saida',   valor: 30000,  categoria: 'aluguel' },
    ],
    cmv: 40000,
  });
  eq(d.margem_contribuicao_pct, 60, 'margem de contribuição 60%');
  eq(d.ponto_equilibrio, 50000, 'empata faturando R$500');
  eq(d.falta_para_empatar, 0, 'já faturou acima do ponto → falta 0');

  // Faturando pouco, mostra quanto falta.
  const fraco = montarDre({
    lancamentos: [
      { tipo: 'entrada', valor: 20000, categoria: 'vendas' },
      { tipo: 'saida',   valor: 30000, categoria: 'aluguel' },
    ],
    cmv: 8000,
  });
  eq(fraco.ponto_equilibrio, 50000, 'ponto de equilíbrio independe do quanto vendeu');
  eq(fraco.falta_para_empatar, 30000, 'falta R$300 pra empatar');
  ok(fraco.lucro_liquido < 0, 'abaixo do ponto → prejuízo');

  // Sem receita não há margem medida: null é honesto, zero mentiria.
  const vazio = montarDre({ lancamentos: [{ tipo: 'saida', valor: 30000, categoria: 'aluguel' }] });
  eq(vazio.ponto_equilibrio, null, 'sem faturamento → ponto de equilíbrio indefinido');
  eq(vazio.falta_para_empatar, null, 'e nada a exibir como "falta"');

  // Margem de contribuição negativa (vende abaixo do custo): não existe volume
  // que salve — devolver um número aqui daria uma meta impossível.
  const prejuizo = montarDre({
    lancamentos: [{ tipo: 'entrada', valor: 10000, categoria: 'vendas' },
                  { tipo: 'saida', valor: 5000, categoria: 'aluguel' }],
    cmv: 12000,
  });
  eq(prejuizo.ponto_equilibrio, null, 'vender abaixo do custo → não há ponto de equilíbrio');
}
console.log('  ok');

// ── 4. Digital: taxas, imposto e a ordem da cascata ────────────────────────
console.log('── 4. digital ──');
{
  const eventos = [
    { tipo: 'venda', valor_bruto: 100000, valor_liquido: 85000, taxa_plataforma: 10000,
      taxa_gateway: 5000, imposto: 0, comissao_afiliado: 0, plataforma: 'hotmart',
      produto_nome: 'Curso', recorrencia: 'mensal' },
    { tipo: 'reembolso', valor_bruto: 10000, plataforma: 'hotmart' },
  ];
  const d = montarDre({ eventos, custosDigital: [{ valor: 20000, categoria: 'trafego_pago' }] });
  eq(d.receita_bruta, 100000, 'reembolso não entra na bruta');
  eq(d.deducoes.reembolsos, 10000, 'reembolso é dedução');
  eq(d.receita_liquida, 75000, 'bruta − taxas − reembolso');
  eq(d.despesas_variaveis, 20000, 'tráfego pago é variável');
  eq(d.lucro_liquido, 55000, 'lucro líquido do digital');
  eq(d.mrr, 85000, 'MRR = líquido das recorrentes');
  eq(d.total_vendas, 1, 'reembolso não conta como venda');

  // Imposto reservado sai da receita líquida (incide sobre faturamento).
  const comImposto = montarDre({ eventos, reservarImposto: true, aliquota: 6 });
  eq(comImposto.deducoes.imposto_reserva, 4500, '6% sobre 75.000');
  eq(comImposto.receita_liquida, 70500, 'reserva reduz a receita líquida');
  // Desligado por padrão — é opt-in.
  eq(montarDre({ eventos }).deducoes.imposto_reserva, 0, 'sem opt-in não reserva imposto');
}
console.log('  ok');

// ── 5. Natureza: mapa, override e desconhecido ─────────────────────────────
console.log('── 5. natureza ──');
{
  eq(naturezaDe('aluguel'), 'fixa', 'aluguel é fixa');
  eq(naturezaDe('marketing'), 'variavel', 'marketing é variável');
  eq(naturezaDe('categoria_que_nao_existe'), 'variavel', 'desconhecida cai em variável');
  eq(naturezaDe('aluguel', 'variavel'), 'variavel', 'o lançamento vence o mapa');
  eq(naturezaDe('marketing', 'fixa'), 'fixa', 'override nos dois sentidos');
  eq(naturezaDe('aluguel', 'lixo'), 'fixa', 'override inválido é ignorado');

  const d = montarDre({
    lancamentos: [
      { tipo: 'entrada', valor: 100000 },
      { tipo: 'saida', valor: 10000, categoria: 'aluguel', natureza: 'variavel' },
    ],
  });
  eq(d.despesas_fixas, 0, 'override tira do fixo');
  eq(d.despesas_variaveis, 10000, 'e joga no variável');
}
console.log('  ok');

// ── 6. Entradas degeneradas ────────────────────────────────────────────────
console.log('── 6. bordas ──');
{
  const vazio = montarDre();
  eq(vazio.receita_bruta, 0, 'sem nada, tudo zero');
  eq(vazio.lucro_liquido, 0, 'lucro zero');
  eq(vazio.margem_pct, 0, 'margem 0 sem divisão por zero');
  eq(vazio.ticket_medio, 0, 'ticket 0 sem divisão por zero');

  // Valores sujos (null/string) não podem virar NaN e contaminar a cascata.
  const sujo = montarDre({
    lancamentos: [
      { tipo: 'entrada', valor: null },
      { tipo: 'entrada', valor: '5000' },
      { tipo: 'saida',   valor: undefined, categoria: 'aluguel' },
    ],
  });
  eq(sujo.receita_bruta, 5000, 'null vira 0, string numérica é aceita');
  ok(Number.isFinite(sujo.lucro_liquido), 'nada de NaN no lucro');
}
console.log('  ok');

// ── Resultado ──────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`❌ ${falhas.length} falha(s):`);
  falhas.forEach(f => console.error('   · ' + f));
  process.exit(1);
}
console.log('✅ DRE gerencial: todos os casos passaram.');
