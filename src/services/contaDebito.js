// =============================================================================
// debitarConta — desconta um valor do saldo de uma conta E registra uma
// transação de saída (Gasto), pra o débito aparecer no histórico/relatórios.
//
// Usado quando o usuário escolhe descontar de uma conta ao aplicar numa meta,
// aportar num investimento, pagar uma dívida ou pagar a fatura do cartão.
//
// A tabela `transacoes` referencia a conta por `carteira_nome` (string) — o
// mesmo mecanismo do gasto comum (que já move o saldo por match de nome).
// =============================================================================
const supabase = require('../db/supabase');

async function debitarConta({ grupoId, walletId, valor, categoria, observacao, userId, data }) {
  const v = parseFloat(valor);
  if (!grupoId || !walletId || !v || v <= 0) return null;

  const { data: wallet } = await supabase.from('wallets')
    .select('id, nome, saldo').eq('id', walletId).eq('grupo_id', grupoId).maybeSingle();
  if (!wallet) throw new Error('Conta não encontrada');

  const idCurto = Math.random().toString(36).substring(2, 8).toUpperCase();
  const base = {
    id_curto:      idCurto,
    grupo_id:      grupoId,
    criado_por:    userId || null,
    tipo:          'Gasto',
    categoria:     categoria || 'Outros',
    valor:         v,
    observacao:    observacao || '',
    carteira_nome: wallet.nome,
    pago:          true,
    data:          data || new Date().toISOString(),
  };
  // Pagamento de fatura = transferência (quitação de dívida), não consumo.
  // Marca a flag pra sair dos relatórios de gasto (migration 046).
  const ehTransferencia = categoria === 'Fatura cartão';
  let { data: tx, error } = await supabase.from('transacoes')
    .insert(ehTransferencia ? { ...base, transferencia: true } : base)
    .select().single();
  // Tolerante: se a coluna `transferencia` ainda não existe (046 não rodou),
  // insere sem ela — o filtro por categoria 'Fatura cartão' já cobre o caso.
  if (error && ehTransferencia && /transferencia/i.test(error.message || '')) {
    ({ data: tx, error } = await supabase.from('transacoes').insert(base).select().single());
  }
  if (error) throw error;

  await supabase.from('wallets')
    .update({ saldo: (wallet.saldo || 0) - v }).eq('id', wallet.id);

  return { tx, conta: { id: wallet.id, nome: wallet.nome } };
}

module.exports = { debitarConta };
