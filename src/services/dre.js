// =============================================================================
// DRE gerencial — a matemática, sem banco.
//
// Fica separada porque é aqui que mora o erro caro: um custo contado duas vezes
// muda o lucro que o dono usa pra decidir preço. A função é pura pra poder ter
// eval (evals/dre.eval.js) e pra o frontend poder portá-la sem copiar query.
//
// AS TRÊS DECISÕES QUE DEFINEM ESTE DRE:
//
// 1. COMPRA DE ESTOQUE NÃO É DESPESA. Comprar mercadoria troca dinheiro por
//    estoque — o resultado só acontece quando vende. Por isso a saída que veio
//    de uma compra (`compra_id`) sai das despesas e entra como CMV no mês em
//    que o item foi VENDIDO. Sem isso, o mês em que o dono abastece a loja
//    aparece no vermelho e o mês seguinte com margem irreal.
//
// 2. CMV VEM DO CUSTO CONGELADO NA VENDA (`venda_itens.custo_unit`), não do
//    custo atual do produto. Reprecificar não pode reescrever a margem de
//    ontem.
//
// 3. FIXO × VARIÁVEL EXISTE POR CAUSA DO PONTO DE EQUILÍBRIO. É o número que o
//    dono de comércio pequeno mais precisa ("quanto tenho de vender pra não
//    perder dinheiro") e ele é impossível de calcular sem essa separação.
// =============================================================================

/**
 * Natureza padrão de cada categoria de saída.
 *
 * Fixa = existe mesmo com a porta fechada (aluguel, salário, internet).
 * Variável = só existe se houver venda/atividade (frete, comissão, anúncio).
 *
 * É um PADRÃO, não uma lei: o lançamento pode trazer `natureza` e vencer o mapa
 * (migration 108) — o aluguel de um quiosque sazonal pode ser variável pra quem
 * está fechando a conta.
 */
const NATUREZA_PADRAO = {
  // Loja física
  aluguel: 'fixa', energia: 'fixa', internet: 'fixa', folha: 'fixa',
  manutencao: 'fixa',
  fornecedor: 'variavel', marketing: 'variavel', transporte: 'variavel',
  impostos: 'variavel',
  // Digital (custos_negocio)
  ferramentas: 'fixa', infra: 'fixa', assinaturas: 'fixa', equipe: 'fixa',
  mentoria: 'fixa',
  trafego_pago: 'variavel', operacional: 'variavel',
};

/** Desconhecido cai em variável de propósito: superestimar despesa fixa infla
 *  o ponto de equilíbrio e assusta o dono com uma meta que ele não tem. */
function naturezaDe(categoria, override) {
  if (override === 'fixa' || override === 'variavel') return override;
  return NATUREZA_PADRAO[categoria] || 'variavel';
}

const cent = (n) => Math.round(Number(n) || 0);
const pct  = (parte, todo) => (todo > 0 ? Number(((parte / todo) * 100).toFixed(2)) : 0);

/**
 * Monta a cascata do DRE.
 *
 * @param {object} e
 * @param {Array}  e.eventos        eventos_financeiros do período (digital)
 * @param {Array}  e.custosDigital  custos_negocio do período
 * @param {Array}  e.lancamentos    lancamentos_negocio PAGOS do período
 * @param {number} e.cmv            custo das mercadorias vendidas (centavos)
 * @param {number} e.aliquota       % do Simples
 * @param {boolean} e.reservarImposto
 */
function montarDre({
  eventos = [], custosDigital = [], lancamentos = [],
  cmv = 0, aliquota = 6, reservarImposto = false,
} = {}) {
  let receita_bruta = 0, taxas_plataforma = 0, taxas_gateway = 0,
      reembolsos = 0, chargebacks = 0, comissoes_afiliado = 0,
      imposto_retido = 0, total_vendas = 0;

  const por_plataforma = {};
  const por_produto = {};

  for (const ev of eventos) {
    if (ev.tipo === 'venda' || ev.tipo === 'assinatura_renovacao') {
      receita_bruta      += cent(ev.valor_bruto);
      taxas_plataforma   += cent(ev.taxa_plataforma);
      taxas_gateway      += cent(ev.taxa_gateway);
      imposto_retido     += cent(ev.imposto);
      comissoes_afiliado += cent(ev.comissao_afiliado);
      total_vendas += 1;
      const p = ev.plataforma || 'outros';
      por_plataforma[p] = por_plataforma[p] || { valor: 0, vendas: 0 };
      por_plataforma[p].valor  += cent(ev.valor_liquido);
      por_plataforma[p].vendas += 1;
      const k = ev.produto_nome || 'Sem nome';
      por_produto[k] = por_produto[k] || { valor: 0, vendas: 0 };
      por_produto[k].valor  += cent(ev.valor_liquido);
      por_produto[k].vendas += 1;
    } else if (ev.tipo === 'reembolso')   reembolsos  += cent(ev.valor_bruto);
    else if (ev.tipo === 'chargeback')    chargebacks += cent(ev.valor_bruto);
  }

  // ── Livro caixa (loja física) ────────────────────────────────────────────
  const despesas_por_categoria = {};
  let despesas_fixas = 0, despesas_variaveis = 0, compras_estoque = 0;

  for (const l of lancamentos) {
    const valor = cent(l.valor);
    if (l.tipo === 'entrada') {
      receita_bruta += valor;
      total_vendas  += 1;
      continue;
    }
    // Decisão 1: compra de mercadoria vira estoque, não despesa do mês.
    if (l.compra_id) { compras_estoque += valor; continue; }

    const cat = l.categoria || 'outros';
    const nat = naturezaDe(cat, l.natureza);
    if (nat === 'fixa') despesas_fixas += valor; else despesas_variaveis += valor;
    despesas_por_categoria[cat] = despesas_por_categoria[cat] || { valor: 0, natureza: nat };
    despesas_por_categoria[cat].valor += valor;
  }

  // ── Custos do digital ────────────────────────────────────────────────────
  for (const c of custosDigital) {
    const valor = cent(c.valor);
    const cat = c.categoria || 'outros';
    const nat = naturezaDe(cat, c.natureza);
    if (nat === 'fixa') despesas_fixas += valor; else despesas_variaveis += valor;
    despesas_por_categoria[cat] = despesas_por_categoria[cat] || { valor: 0, natureza: nat };
    despesas_por_categoria[cat].valor += valor;
  }

  // ── Deduções e receita líquida ───────────────────────────────────────────
  const receita_apos_taxas = receita_bruta - taxas_plataforma - taxas_gateway
                           - reembolsos - chargebacks - comissoes_afiliado;
  // O Simples incide sobre o faturamento; só reserva se o dono ligou.
  const imposto_reserva = reservarImposto
    ? Math.max(0, Math.round(receita_apos_taxas * (Number(aliquota) / 100)))
    : 0;
  const impostos_total  = imposto_retido + imposto_reserva;
  const receita_liquida = receita_apos_taxas - imposto_reserva;

  // ── Resultado ────────────────────────────────────────────────────────────
  const cmvNum      = cent(cmv);
  const lucro_bruto = receita_liquida - cmvNum;
  const resultado_operacional = lucro_bruto - despesas_fixas - despesas_variaveis;
  const lucro_liquido = resultado_operacional;

  // ── Ponto de equilíbrio ──────────────────────────────────────────────────
  // Quanto precisa faturar pra o resultado ser ZERO.
  //   margem de contribuição = o que sobra de cada real vendido depois do que
  //   varia com a venda (CMV + despesas variáveis).
  // Sem receita no mês não há como medir a margem → null (a tela diz por quê,
  // em vez de mostrar "R$ 0,00" e o dono achar que já empatou).
  const margem_contribuicao = receita_liquida - cmvNum - despesas_variaveis;
  const mc_pct = receita_bruta > 0 ? margem_contribuicao / receita_bruta : 0;
  const ponto_equilibrio = (receita_bruta > 0 && mc_pct > 0)
    ? Math.round(despesas_fixas / mc_pct)
    : null;

  const ticket_medio = total_vendas > 0 ? Math.round(receita_bruta / total_vendas) : 0;

  const mrr = eventos
    .filter(ev => (ev.tipo === 'venda' || ev.tipo === 'assinatura_renovacao') && ev.recorrencia === 'mensal')
    .reduce((s, ev) => s + cent(ev.valor_liquido), 0);

  return {
    receita_bruta,
    deducoes: {
      taxas_plataforma, taxas_gateway, reembolsos, chargebacks,
      comissoes_afiliado, imposto_retido, imposto_reserva,
      total: taxas_plataforma + taxas_gateway + reembolsos + chargebacks
           + comissoes_afiliado + imposto_reserva,
    },
    impostos_total,
    receita_liquida,
    cmv: cmvNum,
    lucro_bruto,
    margem_bruta_pct: pct(lucro_bruto, receita_bruta),
    despesas_fixas,
    despesas_variaveis,
    despesas_total: despesas_fixas + despesas_variaveis,
    despesas_por_categoria: Object.entries(despesas_por_categoria)
      .map(([categoria, v]) => ({ categoria, ...v }))
      .sort((a, b) => b.valor - a.valor),
    compras_estoque,
    resultado_operacional,
    lucro_liquido,
    margem_pct: pct(lucro_liquido, receita_bruta),
    margem_contribuicao,
    margem_contribuicao_pct: pct(margem_contribuicao, receita_bruta),
    ponto_equilibrio,
    // Quanto falta faturar pra empatar (0 quando já passou do ponto).
    falta_para_empatar: ponto_equilibrio == null
      ? null : Math.max(0, ponto_equilibrio - receita_bruta),
    total_vendas,
    ticket_medio,
    mrr,
    arr: mrr * 12,
    por_plataforma: Object.entries(por_plataforma)
      .map(([plataforma, v]) => ({ plataforma, ...v }))
      .sort((a, b) => b.valor - a.valor),
    por_produto: Object.entries(por_produto)
      .map(([nome, v]) => ({ nome, ...v }))
      .sort((a, b) => b.valor - a.valor).slice(0, 10),
  };
}

module.exports = { montarDre, naturezaDe, NATUREZA_PADRAO };
