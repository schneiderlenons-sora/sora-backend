// ─────────────────────────────────────────────────────────────────────────────
// Importação de extrato (OFX/CSV/PDF): mover o que já foi importado na conta
// ERRADA para a conta certa.
//
// POR QUE EXISTE (relato de nov/2026). A tela de importação abre com a conta
// corrente escolhida; o cliente importou a FATURA do cartão sem perceber e os
// lançamentos foram parar na conta corrente. Ao importar de novo, agora no
// cartão, o servidor descartou TUDO como repetido — o FITID (id único de cada
// lançamento no OFX) é conferido no GRUPO inteiro — e a tela disse
// "0 transações importadas", sem explicar nada. Não havia saída.
//
// ⚠️ SÓ LANÇAMENTO IMPORTADO DE EXTRATO: tem `fitid` e NÃO veio do Open Finance
// (`of_tx_id` nulo). Lançamento do banco conectado é do sync e não se move.
//
// ⚠️ NÃO MEXE EM SALDO, e é de propósito: a importação em massa nunca mexeu no
// saldo da conta (o extrato do banco já reflete aquele dinheiro — ver a rota
// POST /transacoes/bulk). Mover entre contas, então, também não mexe; ajustar
// aqui criaria uma diferença que o insert nunca fez.
//
// O banco entra por parâmetro pra o eval rodar com um falso.
// ─────────────────────────────────────────────────────────────────────────────

const MAX = 1000;

/**
 * @param {object} db  cliente do Supabase (ou falso)
 * @param {{ grupoId: string, fitids: string[], destino: string }} p
 *   `destino` é o NOME de uma carteira que JÁ EXISTE no grupo (quem chama confere).
 * @returns {Promise<{ movidas: number }>}
 */
async function moverImportadas(db, { grupoId, fitids, destino }) {
  const lista = [...new Set((Array.isArray(fitids) ? fitids : [])
    .filter((f) => typeof f === 'string' && f.trim())
    .map((f) => f.trim()))].slice(0, MAX);
  if (!grupoId || !destino || !lista.length) return { movidas: 0 };

  const { data, error } = await db.from('transacoes')
    .update({ carteira_nome: destino })
    .eq('grupo_id', grupoId)
    .in('fitid', lista)
    .is('of_tx_id', null)
    .neq('carteira_nome', destino)
    .select('id');
  if (error) throw error;
  return { movidas: (data || []).length };
}

module.exports = { moverImportadas, MAX };
