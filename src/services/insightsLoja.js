// =============================================================================
// Insights de loja física — o que a Sora percebe olhando o negócio.
//
// O motor antigo (handlers/insights-negocio.js) só entende infoproduto: fala de
// plataforma, produto digital, churn. Uma padaria não tem nada disso.
//
// TRÊS REGRAS DE PRODUTO QUE VALEM MAIS QUE OS ALGORITMOS AQUI:
//
// 1. INSIGHT QUE NÃO CABE NUMA AÇÃO É RUÍDO. Todo item aponta pra uma tela e
//    diz o que fazer. "Sua margem caiu" sem o que fazer não muda nada.
//
// 2. ORDEM É POR AMEAÇA AO CAIXA, não por quanto é curioso. Vender abaixo do
//    custo vem antes de "seu melhor dia é sábado".
//
// 3. NÚMERO PEQUENO NÃO VIRA ALERTA. Um produto de R$ 3 parado não merece a
//    atenção do dono, e alertar sobre ele ensina a ignorar os alertas.
//
// Puro, sem banco: quem busca dado é a rota. Com eval (evals/insightsLoja).
// =============================================================================

const fmt = (c) => new Intl.NumberFormat('pt-BR',
  { style: 'currency', currency: 'BRL' }).format((Number(c) || 0) / 100);

/** Só vale alertar sobre dinheiro que o dono sentiria. */
const RELEVANTE = 5000;          // R$ 50
const DIAS_PARADO = 45;          // sem venda → estoque encalhado
const DIAS_CLIENTE_SUMIDO = 45;  // comprava sempre e parou

const nivel = { critico: 0, atencao: 1, sucesso: 2, info: 3 };

/**
 * @param {object} d
 * @param {object} d.dre        DRE gerencial do mês (services/dre)
 * @param {Array}  d.produtos   [{id, nome, preco, custo, estoque_atual, estoque_min, eh_servico, ultima_venda}]
 * @param {Array}  d.clientes   [{id, nome, ultima_compra, compras}]
 * @param {Array}  d.receber    lançamentos de entrada pendentes [{descricao, valor, vencimento}]
 * @param {Array}  d.pagar      lançamentos de saída pendentes  [{descricao, valor, vencimento}]
 * @param {string} d.hoje       'YYYY-MM-DD' (fuso SP — quem chama resolve)
 */
function analisar({ dre = null, produtos = [], clientes = [], receber = [], pagar = [], hoje } = {}) {
  const out = [];
  const dia = hoje || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const diasEntre = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

  // ── 1. Vender abaixo do custo ────────────────────────────────────────────
  // O erro mais caro do comércio pequeno: quanto mais vende, mais perde. Vem
  // primeiro sempre.
  const prejuizo = produtos.filter(p =>
    !p.eh_servico && Number(p.custo) > 0 && Number(p.preco) > 0 && Number(p.preco) <= Number(p.custo));
  if (prejuizo.length) {
    const pior = prejuizo.slice().sort((a, b) => (a.preco - a.custo) - (b.preco - b.custo))[0];
    out.push({
      chave: 'preco_abaixo_custo',
      severidade: 'critico',
      titulo: prejuizo.length === 1
        ? `${pior.nome} está sendo vendido no prejuízo`
        : `${prejuizo.length} produtos vendidos no prejuízo`,
      texto: `${pior.nome} custa ${fmt(pior.custo)} e sai por ${fmt(pior.preco)}. Cada venda tira ${fmt(pior.custo - pior.preco)} do caixa — vender mais só aumenta a perda.`,
      acao: 'Rever preços', url: '/negocios/produtos',
      valor: prejuizo.reduce((s, p) => s + (p.custo - p.preco), 0),
    });
  }

  // ── 2. Conta a receber vencida ───────────────────────────────────────────
  const vencidas = receber.filter(r => r.vencimento && r.vencimento < dia);
  const totalVencido = vencidas.reduce((s, r) => s + (Number(r.valor) || 0), 0);
  if (totalVencido >= RELEVANTE) {
    const maisVelha = vencidas.slice().sort((a, b) => (a.vencimento < b.vencimento ? -1 : 1))[0];
    out.push({
      chave: 'receber_vencido',
      severidade: 'critico',
      titulo: `${fmt(totalVencido)} que já era pra ter entrado`,
      texto: `${vencidas.length} ${vencidas.length === 1 ? 'cobrança venceu' : 'cobranças venceram'} e não foram pagas. A mais antiga é de ${diasEntre(maisVelha.vencimento, dia)} dias atrás${maisVelha.descricao ? ` (${maisVelha.descricao})` : ''}.`,
      acao: 'Ver a receber', url: '/negocios/receber',
      valor: totalVencido,
    });
  }

  // ── 3. Ponto de equilíbrio com o mês acabando ────────────────────────────
  if (dre && dre.ponto_equilibrio != null && dre.receita_bruta < dre.ponto_equilibrio) {
    const [ano, mes] = dia.split('-').map(Number);
    const diasMes = new Date(ano, mes, 0).getDate();
    const diasRestantes = diasMes - Number(dia.slice(8, 10));
    const falta = dre.ponto_equilibrio - dre.receita_bruta;
    // Só vira alerta quando ainda dá pra reagir mas o tempo aperta.
    if (diasRestantes <= 10 && falta >= RELEVANTE) {
      out.push({
        chave: 'abaixo_equilibrio',
        severidade: 'atencao',
        titulo: `Faltam ${fmt(falta)} pra fechar o mês no zero`,
        texto: diasRestantes <= 0
          ? `O mês acabou abaixo do ponto de equilíbrio. As contas fixas de ${fmt(dre.despesas_fixas)} não foram cobertas pela margem das vendas.`
          : `Restam ${diasRestantes} ${diasRestantes === 1 ? 'dia' : 'dias'} e ainda falta ${fmt(falta)} de faturamento pra cobrir o custo fixo de ${fmt(dre.despesas_fixas)}.`,
        acao: 'Ver DRE', url: '/negocios/dre',
        valor: falta,
      });
    }
  }

  // ── 4. Ruptura: vai faltar o que vende ───────────────────────────────────
  const acabando = produtos.filter(p =>
    !p.eh_servico && p.estoque_min != null &&
    Number(p.estoque_atual) <= Number(p.estoque_min));
  if (acabando.length) {
    const nomes = acabando.slice(0, 3).map(p => p.nome).join(', ');
    out.push({
      chave: 'estoque_baixo',
      severidade: 'atencao',
      titulo: acabando.length === 1
        ? `${acabando[0].nome} está acabando`
        : `${acabando.length} produtos no limite do estoque`,
      texto: `${nomes}${acabando.length > 3 ? ` e mais ${acabando.length - 3}` : ''} ${acabando.length === 1 ? 'chegou' : 'chegaram'} ao mínimo que você definiu. Produto em falta é venda perdida que não aparece em relatório nenhum.`,
      acao: 'Ver estoque', url: '/negocios/estoque',
    });
  }

  // ── 5. Dinheiro parado ───────────────────────────────────────────────────
  const parados = produtos.filter(p => {
    if (p.eh_servico || Number(p.estoque_atual) <= 0) return false;
    const valor = Number(p.estoque_atual) * (Number(p.custo) || 0);
    if (valor < RELEVANTE) return false;                     // regra 3
    return !p.ultima_venda || diasEntre(p.ultima_venda, dia) >= DIAS_PARADO;
  });
  const paradoTotal = parados.reduce((s, p) => s + p.estoque_atual * (p.custo || 0), 0);
  if (paradoTotal >= RELEVANTE * 2) {
    const pior = parados.slice()
      .sort((a, b) => (b.estoque_atual * b.custo) - (a.estoque_atual * a.custo))[0];
    out.push({
      chave: 'estoque_parado',
      severidade: 'atencao',
      titulo: `${fmt(paradoTotal)} parados na prateleira`,
      texto: `${parados.length} ${parados.length === 1 ? 'produto está' : 'produtos estão'} há mais de ${DIAS_PARADO} dias sem vender. O maior é ${pior.nome}, com ${fmt(pior.estoque_atual * pior.custo)} em estoque. É dinheiro que já saiu do caixa e não voltou.`,
      acao: 'Ver estoque', url: '/negocios/estoque',
      valor: paradoTotal,
    });
  }

  // ── 6. Cliente bom que sumiu ─────────────────────────────────────────────
  // Só quem tinha hábito (3+ compras) — cliente de uma compra só não "sumiu".
  const sumidos = clientes.filter(c =>
    (Number(c.compras) || 0) >= 3 && c.ultima_compra &&
    diasEntre(c.ultima_compra, dia) >= DIAS_CLIENTE_SUMIDO);
  if (sumidos.length) {
    const nomes = sumidos.slice(0, 3).map(c => c.nome).join(', ');
    out.push({
      chave: 'cliente_sumido',
      severidade: 'info',
      titulo: sumidos.length === 1
        ? `${sumidos[0].nome} sumiu`
        : `${sumidos.length} clientes fiéis sumiram`,
      texto: `${nomes} ${sumidos.length === 1 ? 'comprava' : 'compravam'} com frequência e não ${sumidos.length === 1 ? 'aparece' : 'aparecem'} há mais de ${DIAS_CLIENTE_SUMIDO} dias. Uma mensagem custa nada e traz de volta mais barato que anúncio.`,
      acao: 'Ver clientes', url: '/negocios/clientes',
    });
  }

  // ── 7. Conta a pagar vencendo ────────────────────────────────────────────
  const proximas = pagar.filter(p => p.vencimento && p.vencimento >= dia && diasEntre(dia, p.vencimento) <= 7);
  const totalProximo = proximas.reduce((s, p) => s + (Number(p.valor) || 0), 0);
  if (totalProximo >= RELEVANTE) {
    out.push({
      chave: 'pagar_semana',
      severidade: 'info',
      titulo: `${fmt(totalProximo)} pra pagar nos próximos 7 dias`,
      texto: `${proximas.length} ${proximas.length === 1 ? 'conta vence' : 'contas vencem'} nesta semana. Confira se o caixa cobre antes de comprar mercadoria.`,
      acao: 'Ver contas', url: '/negocios/contas',
      valor: totalProximo,
    });
  }

  // ── 8. Margem boa: o reforço positivo, que também ensina ─────────────────
  if (dre && dre.receita_bruta > 0 && dre.margem_pct >= 20 && dre.lucro_liquido >= RELEVANTE) {
    out.push({
      chave: 'margem_saudavel',
      severidade: 'sucesso',
      titulo: `Margem de ${dre.margem_pct.toFixed(0)}% neste mês`,
      texto: `De cada R$ 100 vendidos, ${(dre.margem_pct).toFixed(0)} viraram lucro (${fmt(dre.lucro_liquido)} no total). Guarde parte disso: é o que paga o mês fraco.`,
      acao: 'Ver DRE', url: '/negocios/dre',
      valor: dre.lucro_liquido,
    });
  }

  // Ameaça ao caixa primeiro; dentro do mesmo nível, o valor maior.
  return out.sort((a, b) =>
    (nivel[a.severidade] - nivel[b.severidade]) || ((b.valor || 0) - (a.valor || 0)));
}

module.exports = { analisar, RELEVANTE, DIAS_PARADO, DIAS_CLIENTE_SUMIDO };
