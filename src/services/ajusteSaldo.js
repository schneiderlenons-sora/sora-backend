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

async function registrarAjuste({ grupoId, criadoPor, carteiraNome, diff }) {
  const d = Math.round((Number(diff) || 0) * 100) / 100;
  if (!d || !grupoId || !carteiraNome) return null;
  const { data, error } = await supabase.from('transacoes').insert({
    id_curto:      Math.random().toString(36).substring(2, 8).toUpperCase(),
    grupo_id:      grupoId,
    criado_por:    criadoPor || null,
    tipo:          d > 0 ? 'Recebimento' : 'Gasto',
    categoria:     '🔧 Ajuste',
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
