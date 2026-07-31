// =============================================================================
// Motor do estoque (migration 107).
//
// O livro-razão (`estoque_movimentos`) é a VERDADE; `produtos_negocio.
// estoque_atual` e `.custo` são cache pra listar sem varrer tudo. Toda escrita
// passa por aqui pra os dois nunca divergirem.
//
// CUSTO MÉDIO MÓVEL — a regra que faz "lucro por produto" ser real:
//     novo = (saldo × custo_atual + qtd × custo_compra) / (saldo + qtd)
// Comprei 10 a R$10, depois 10 a R$14 → custo médio R$12. Vendi a R$20: a
// margem é sobre 12, não sobre a última compra nem sobre a primeira.
//
// ⚠️ SAÍDA NÃO MEXE NO CUSTO MÉDIO. Só consome saldo. Recalcular o custo na
// saída é o erro clássico que faz o custo derreter a cada venda — e o lucro
// aparecer inflado.
// =============================================================================
const supabase = require('../db/supabase');

const cent = (v) => Math.round(Number(v) || 0);
const qtd  = (v) => Math.round((Number(v) || 0) * 1000) / 1000;  // 3 casas
const hojeSP = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

/**
 * Custo médio móvel após uma ENTRADA. Puro, sem banco — é o que o eval trava.
 *
 * Casos de borda que importam:
 * · saldo ZERO (ou negativo por acerto pendente) → o custo passa a ser o da
 *   compra. Fazer média com saldo zero daria divisão por zero ou manteria um
 *   custo velho que não corresponde a nada em prateleira.
 * · custo da compra ZERO (brinde, bonificação) → mantém o custo atual, senão
 *   uma doação zeraria o custo de todo o estoque.
 */
function custoMedioApos(saldoAtual, custoAtual, qtdEntrada, custoEntrada) {
  const s = Number(saldoAtual) || 0;
  const q = Number(qtdEntrada) || 0;
  if (q <= 0) return cent(custoAtual);
  if (!custoEntrada) return cent(custoAtual);   // brinde não zera o custo
  if (s <= 0) return cent(custoEntrada);        // sem saldo, o novo custo manda
  const total = (s * (Number(custoAtual) || 0)) + (q * (Number(custoEntrada) || 0));
  return cent(total / (s + q));
}

/** Saldo real pelo livro-razão (fonte da verdade). */
async function saldoReal(produtoId) {
  const { data } = await supabase.from('estoque_movimentos')
    .select('tipo, quantidade').eq('produto_id', produtoId);
  return (data || []).reduce(
    (s, m) => s + (m.tipo === 'entrada' ? Number(m.quantidade) : -Number(m.quantidade)), 0);
}

/**
 * Registra um movimento e atualiza o cache do produto.
 *
 * Devolve `{ movimento, saldo, custo }`. Produto que não controla estoque é
 * ignorado em silêncio — serviço não tem prateleira, e falhar aqui derrubaria
 * a venda inteira por causa de um corte de cabelo.
 */
async function movimentar({
  empresaId, produtoId, tipo, motivo = 'ajuste', quantidade,
  custoUnit = 0, vendaId = null, compraId = null, observacao = null, data = null,
} = {}) {
  if (!empresaId || !produtoId || !quantidade) return null;

  const { data: produto } = await supabase.from('produtos_negocio')
    .select('id, estoque_atual, custo, controla_estoque, eh_servico')
    .eq('id', produtoId).eq('empresa_id', empresaId).maybeSingle();
  if (!produto) return null;
  if (produto.eh_servico || !produto.controla_estoque) return null;

  const q = Math.abs(qtd(quantidade));
  const { data: mov, error } = await supabase.from('estoque_movimentos').insert({
    empresa_id: empresaId, produto_id: produtoId,
    tipo, motivo, quantidade: q, custo_unit: cent(custoUnit),
    venda_id: vendaId, compra_id: compraId,
    observacao, data: data || hojeSP(),
  }).select().single();
  if (error) throw error;

  const saldoAntes = Number(produto.estoque_atual) || 0;
  const saldo = qtd(tipo === 'entrada' ? saldoAntes + q : saldoAntes - q);

  // Só ENTRADA mexe no custo médio (ver cabeçalho).
  const custo = tipo === 'entrada'
    ? custoMedioApos(saldoAntes, produto.custo, q, custoUnit)
    : cent(produto.custo);

  await supabase.from('produtos_negocio')
    .update({ estoque_atual: saldo, custo, updated_at: new Date().toISOString() })
    .eq('id', produtoId);

  return { movimento: mov, saldo, custo };
}

/**
 * Baixa os itens de uma venda. Best-effort POR ITEM: um produto sem controle
 * de estoque (ou já apagado) não pode impedir o registro da venda — o dinheiro
 * é mais importante que o saldo, e o saldo se acerta depois.
 */
async function baixarVenda({ empresaId, vendaId, itens, data }) {
  const feitos = [];
  for (const i of itens || []) {
    if (!i.produto_id) continue;                 // item avulso não tem estoque
    try {
      const r = await movimentar({
        empresaId, produtoId: i.produto_id, tipo: 'saida', motivo: 'venda',
        quantidade: i.quantidade, custoUnit: i.custo_unit,
        vendaId, data,
      });
      if (r) feitos.push({ produto_id: i.produto_id, saldo: r.saldo });
    } catch (e) {
      console.warn('[estoque] baixa da venda falhou:', i.produto_id, e.message);
    }
  }
  return feitos;
}

/**
 * Desfaz a baixa quando a venda é cancelada — devolve à prateleira.
 * Sem isto, cancelar venda faria o estoque encolher pra sempre.
 * ⚠️ A devolução NÃO recalcula o custo médio: a entrada é um estorno, não uma
 * compra nova, e mexer no custo aqui distorceria a margem histórica.
 */
async function estornarVenda({ empresaId, vendaId }) {
  const { data: movs } = await supabase.from('estoque_movimentos')
    .select('produto_id, quantidade, custo_unit')
    .eq('venda_id', vendaId).eq('tipo', 'saida');

  for (const m of movs || []) {
    try {
      const { data: p } = await supabase.from('produtos_negocio')
        .select('estoque_atual').eq('id', m.produto_id).maybeSingle();
      await supabase.from('estoque_movimentos').insert({
        empresa_id: empresaId, produto_id: m.produto_id,
        tipo: 'entrada', motivo: 'devolucao', quantidade: m.quantidade,
        custo_unit: m.custo_unit, venda_id: vendaId,
        observacao: 'Estorno de venda cancelada', data: hojeSP(),
      });
      await supabase.from('produtos_negocio')
        .update({ estoque_atual: qtd((Number(p?.estoque_atual) || 0) + Number(m.quantidade)) })
        .eq('id', m.produto_id);
    } catch (e) {
      console.warn('[estoque] estorno falhou:', m.produto_id, e.message);
    }
  }
  return (movs || []).length;
}

/** Entrada dos itens de uma compra recebida (é aqui que o custo médio muda). */
async function entrarCompra({ empresaId, compraId, itens, data }) {
  const feitos = [];
  for (const i of itens || []) {
    if (!i.produto_id) continue;
    try {
      const r = await movimentar({
        empresaId, produtoId: i.produto_id, tipo: 'entrada', motivo: 'compra',
        quantidade: i.quantidade, custoUnit: i.custo_unit, compraId, data,
      });
      if (r) feitos.push({ produto_id: i.produto_id, saldo: r.saldo, custo: r.custo });
    } catch (e) {
      console.warn('[estoque] entrada da compra falhou:', i.produto_id, e.message);
    }
  }
  return feitos;
}

/** Reconstrói `estoque_atual` a partir do livro-razão (conserta divergência). */
async function recalcular(produtoId) {
  const saldo = qtd(await saldoReal(produtoId));
  await supabase.from('produtos_negocio').update({ estoque_atual: saldo }).eq('id', produtoId);
  return saldo;
}

module.exports = {
  custoMedioApos, movimentar, baixarVenda, estornarVenda, entrarCompra,
  saldoReal, recalcular,
};
