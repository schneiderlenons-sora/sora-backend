// =====================================================================
// Rastro de ajuste de saldo.
//
// Quando o saldo de uma conta muda "do nada" — ajustar saldo, adicionar saldo,
// editar o saldo no painel — a diferença vira uma transação de AJUSTE. Sem isso
// o saldo é só sobrescrito e o dinheiro SOME do histórico: o extrato não
// reconcilia e "cadê meus R$ 50?" fica sem resposta.
//
//   diff > 0 → entrou grana não registrada → Recebimento
//   diff < 0 → saiu grana não registrada   → Gasto
//
// Categoria própria "🔧 Ajuste" pra não se misturar com salário/mercado reais
// nas análises.
//
// ⚠️ NÃO use na CRIAÇÃO da conta: saldo inicial é ABERTURA (patrimônio), não
// receita. Contá-lo como receita mentiria no relatório do mês (você já tinha o
// dinheiro, não ganhou) e misturaria estoque com fluxo.
// =====================================================================
const supabase = require('../db/supabase');

// ⚠️ UM NOME POR DIREÇÃO. `categorias.tipo` é um só por linha, então a mesma
// "categoria" não pode ser despesa e receita ao mesmo tempo. Mesma solução do
// `PIX` → `Pix enviado` em categorizar.js.
//
// ⚠️ E OS DOIS PRECISAM EXISTIR NA TAXONOMIA (migration 135). `categoria` é
// texto livre: um nome que não é categoria cadastrada entra na transação,
// conta no total do painel e SOME da aba Categorias. Foi assim que R$ 300 de
// ajuste ficaram invisíveis, com o dashboard e a aba Categorias divergindo em
// exatamente esse valor — e ninguém sabendo de onde vinha a diferença.
const CAT_SAIDA   = '🔧 Ajuste';
const CAT_ENTRADA = '🔧 Ajuste recebido';

// Grupo criado DEPOIS da 135 não passou pelo backfill dela. Garantir aqui é
// barato (ajuste de saldo é raro) e impede a categoria órfã de voltar sozinha.
async function garantirCategorias(grupoId) {
  try {
    await supabase.rpc('criar_cat_v4', { p_grupo: grupoId, p_nome: 'Ajuste',          p_icone: '🔧', p_tipo: 'despesa' });
    await supabase.rpc('criar_cat_v4', { p_grupo: grupoId, p_nome: 'Ajuste recebido', p_icone: '🔧', p_tipo: 'receita' });
  } catch (e) {
    // Tolerante de propósito: o rastro do dinheiro vale mais que a categoria.
    console.warn('[ajusteSaldo] não consegui garantir a categoria:', e.message);
  }
}

async function registrarAjuste({ grupoId, criadoPor, carteiraNome, diff }) {
  const d = Math.round((Number(diff) || 0) * 100) / 100;
  if (!d || !grupoId || !carteiraNome) return null;
  await garantirCategorias(grupoId);
  const { data, error } = await supabase.from('transacoes').insert({
    id_curto:      Math.random().toString(36).substring(2, 8).toUpperCase(),
    grupo_id:      grupoId,
    criado_por:    criadoPor || null,
    tipo:          d > 0 ? 'Recebimento' : 'Gasto',
    categoria:     d > 0 ? CAT_ENTRADA : CAT_SAIDA,
    valor:         Math.abs(d),
    observacao:    `Ajuste de saldo (${carteiraNome})`,
    carteira_nome: carteiraNome,
    pago:          true,
    data:          new Date().toISOString(),
  }).select('id_curto').single();
  if (error) { console.error('[ajusteSaldo] falhou:', error.message); return null; }
  return data;
}

module.exports = { registrarAjuste };
