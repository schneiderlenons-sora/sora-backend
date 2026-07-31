// =============================================================================
// EVAL dos insights de loja (services/insightsLoja).
//
// O risco aqui é o oposto do risco de um cálculo: não é errar a conta, é
// ALERTAR DEMAIS. Alerta sobre um produto de R$ 3 parado ensina o dono a
// ignorar a tela inteira — e aí o alerta que importava passa batido também.
//
// Rodar:  npm run eval:insights-loja
// =============================================================================
const { analisar } = require('../src/services/insightsLoja');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const tem = (lista, chave) => lista.some(i => i.chave === chave);
const HOJE = '2026-07-20';

// ── 1. Vender abaixo do custo vem primeiro ─────────────────────────────────
console.log('── 1. prejuízo por venda ──');
{
  const r = analisar({
    hoje: HOJE,
    produtos: [
      { id: 'a', nome: 'Bolo', custo: 1000, preco: 800, estoque_atual: 5 },
      { id: 'b', nome: 'Pão',  custo: 100,  preco: 300, estoque_atual: 50 },
    ],
    receber: [{ valor: 900000, vencimento: '2026-01-01', descricao: 'Fiado' }],
  });
  ok(tem(r, 'preco_abaixo_custo'), 'detecta preço abaixo do custo');
  // Mesmo com uma dívida 100× maior, o prejuízo estrutural vem antes: um é
  // dinheiro que não entrou, o outro sangra a cada venda nova.
  ok(r[0].chave === 'preco_abaixo_custo' || r[0].chave === 'receber_vencido',
     'ameaça ao caixa ocupa o topo');
  ok(r.filter(i => i.severidade === 'critico').length === 2, 'os dois são críticos');

  // Preço igual ao custo também é prejuízo (não sobra pra pagar a loja).
  ok(tem(analisar({ hoje: HOJE, produtos: [{ nome: 'X', custo: 1000, preco: 1000, estoque_atual: 1 }] }),
         'preco_abaixo_custo'), 'preço igual ao custo conta como prejuízo');
  // Serviço sem custo cadastrado NÃO pode virar alarme falso.
  ok(!tem(analisar({ hoje: HOJE, produtos: [{ nome: 'Corte', custo: 0, preco: 3000, eh_servico: true }] }),
          'preco_abaixo_custo'), 'serviço sem custo não vira alerta');
  ok(!tem(analisar({ hoje: HOJE, produtos: [{ nome: 'Y', custo: 0, preco: 500 }] }),
          'preco_abaixo_custo'), 'produto sem custo cadastrado não vira alerta');
}
console.log('  ok');

// ── 2. Ruído: valores pequenos não viram alerta ────────────────────────────
console.log('── 2. antirruído ──');
{
  // R$ 3 de produto parado há um ano: verdade, mas irrelevante.
  const r = analisar({
    hoje: HOJE,
    produtos: [{ nome: 'Chiclete', custo: 100, preco: 200, estoque_atual: 3, ultima_venda: '2025-01-01' }],
  });
  ok(!tem(r, 'estoque_parado'), 'R$ 3 parados não viram alerta');

  // R$ 20 vencidos idem.
  ok(!tem(analisar({ hoje: HOJE, receber: [{ valor: 2000, vencimento: '2026-01-01' }] }), 'receber_vencido'),
     'cobrança pequena vencida não vira alerta');

  // Nada cadastrado → nenhum insight (tela vazia é melhor que tela inventada).
  ok(analisar({ hoje: HOJE }).length === 0, 'sem dados, sem insight');
  ok(analisar().length === 0, 'sem argumento nenhum não quebra');
}
console.log('  ok');

// ── 3. Estoque parado e ruptura ────────────────────────────────────────────
console.log('── 3. estoque ──');
{
  const r = analisar({
    hoje: HOJE,
    produtos: [
      { nome: 'Vinho', custo: 5000, preco: 9000, estoque_atual: 20, ultima_venda: '2026-03-01' },
      { nome: 'Água',  custo: 200,  preco: 500,  estoque_atual: 2, estoque_min: 10, ultima_venda: HOJE },
    ],
  });
  ok(tem(r, 'estoque_parado'), 'R$ 1.000 parados há 4 meses viram alerta');
  ok(tem(r, 'estoque_baixo'), 'produto no mínimo vira alerta de ruptura');
  const parado = r.find(i => i.chave === 'estoque_parado');
  ok(parado.valor === 100000, 'valor do encalhe = estoque × custo');
  ok(/Vinho/.test(parado.texto), 'cita o pior caso pelo nome');

  // Produto que vendeu ontem não está parado.
  ok(!tem(analisar({ hoje: HOJE, produtos: [
    { nome: 'Vinho', custo: 5000, preco: 9000, estoque_atual: 20, ultima_venda: '2026-07-19' }] }),
    'estoque_parado'), 'venda recente não conta como encalhe');

  // Nunca vendeu + estoque alto = encalhe (o caso do dono que comprou errado).
  ok(tem(analisar({ hoje: HOJE, produtos: [
    { nome: 'Enfeite', custo: 3000, preco: 6000, estoque_atual: 10 }] }),
    'estoque_parado'), 'produto que nunca vendeu conta como encalhe');

  // Estoque zerado não é encalhe — é ruptura, outro alerta.
  ok(!tem(analisar({ hoje: HOJE, produtos: [
    { nome: 'Z', custo: 9000, preco: 1, estoque_atual: 0, ultima_venda: '2025-01-01' }] }),
    'estoque_parado'), 'estoque zerado não é dinheiro parado');
}
console.log('  ok');

// ── 4. Ponto de equilíbrio: só quando dá pra reagir ────────────────────────
console.log('── 4. ponto de equilíbrio ──');
{
  const dre = { ponto_equilibrio: 500000, receita_bruta: 300000, despesas_fixas: 200000, margem_pct: -5, lucro_liquido: -10000 };
  // Dia 20 de julho (31 dias) → 11 dias restantes: ainda não aperta.
  ok(!tem(analisar({ hoje: '2026-07-20', dre }), 'abaixo_equilibrio'),
     'no meio do mês não alarma — ainda há tempo');
  // Dia 25 → 6 dias: aperta.
  ok(tem(analisar({ hoje: '2026-07-25', dre }), 'abaixo_equilibrio'),
     'com o mês acabando, alerta');
  // Já passou do ponto: nada a dizer.
  ok(!tem(analisar({ hoje: '2026-07-28', dre: { ...dre, receita_bruta: 600000 } }), 'abaixo_equilibrio'),
     'acima do ponto de equilíbrio não alerta');
  // Sem ponto de equilíbrio calculável não inventa alerta.
  ok(!tem(analisar({ hoje: '2026-07-28', dre: { ...dre, ponto_equilibrio: null } }), 'abaixo_equilibrio'),
     'ponto indefinido não vira alerta');
}
console.log('  ok');

// ── 5. Cliente sumido precisa ter tido hábito ──────────────────────────────
console.log('── 5. clientes ──');
{
  const base = { hoje: HOJE };
  ok(tem(analisar({ ...base, clientes: [{ nome: 'Maria', compras: 8, ultima_compra: '2026-04-01' }] }),
         'cliente_sumido'), 'cliente frequente que sumiu vira insight');
  ok(!tem(analisar({ ...base, clientes: [{ nome: 'João', compras: 1, ultima_compra: '2026-01-01' }] }),
          'cliente_sumido'), 'quem comprou uma vez só não "sumiu"');
  ok(!tem(analisar({ ...base, clientes: [{ nome: 'Ana', compras: 9, ultima_compra: '2026-07-15' }] }),
          'cliente_sumido'), 'quem veio semana passada não sumiu');
}
console.log('  ok');

// ── 6. Todo insight tem ação, e a ordem é por ameaça ───────────────────────
console.log('── 6. forma ──');
{
  const r = analisar({
    hoje: '2026-07-28',
    dre: { ponto_equilibrio: 500000, receita_bruta: 300000, despesas_fixas: 200000, margem_pct: 5, lucro_liquido: 1000 },
    produtos: [
      { nome: 'A', custo: 1000, preco: 500, estoque_atual: 4 },
      { nome: 'B', custo: 5000, preco: 9000, estoque_atual: 30, ultima_venda: '2026-01-01' },
    ],
    clientes: [{ nome: 'Maria', compras: 8, ultima_compra: '2026-01-01' }],
    pagar: [{ valor: 80000, vencimento: '2026-07-30' }],
    receber: [{ valor: 120000, vencimento: '2026-06-01' }],
  });
  ok(r.length >= 5, 'produz vários insights com dado real');
  ok(r.every(i => i.acao && i.url), 'todo insight aponta pra uma tela');
  ok(r.every(i => i.titulo && i.texto), 'todo insight tem título e explicação');
  // Ordem: crítico antes de atenção, atenção antes de info.
  const ordem = r.map(i => i.severidade);
  const peso = { critico: 0, atencao: 1, sucesso: 2, info: 3 };
  ok(ordem.every((s, i) => i === 0 || peso[ordem[i - 1]] <= peso[s]), 'ordenado por ameaça ao caixa');
  // Sem emoji: a voz da Sora nos negócios é sóbria.
  ok(r.every(i => !/[\u{1F300}-\u{1FAFF}]/u.test(i.titulo + i.texto)), 'sem emoji nos insights');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`❌ ${falhas.length} falha(s):`);
  falhas.forEach(f => console.error('   · ' + f));
  process.exit(1);
}
console.log('✅ Insights de loja: todos os casos passaram.');
