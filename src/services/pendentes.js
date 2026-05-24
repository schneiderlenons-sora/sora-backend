// =============================================================================
// State machine de conversas pendentes da Sora.
// Quando a Sora faz uma pergunta (ex.: "de qual conta saiu?"), ela cria
// um registro em transacoes_pendentes e processa a resposta do user na
// próxima mensagem. TTL curto (10min) — se mudar de assunto, expira.
// =============================================================================

const supabase = require('../db/supabase');

/**
 * Cria um registro de pendente pra próxima mensagem do user resolver.
 *
 * @param {string} userId            UUID do user
 * @param {string} tipoPergunta      'escolher_conta' | 'marcar_principal' | 'criar_conta'
 * @param {object} contexto          dados extras (ex.: { transacao_id, valor, opcoes_contas })
 * @param {string} [transacaoId]     opcional — referência à tx em questão
 */
async function criarPendente({ userId, tipoPergunta, contexto, transacaoId }) {
  if (!userId || !tipoPergunta) return null;

  // Limpa pendentes antigas do mesmo user (só 1 ativa por vez)
  await supabase
    .from('transacoes_pendentes')
    .delete()
    .eq('user_id', userId);

  const { data, error } = await supabase
    .from('transacoes_pendentes')
    .insert({
      user_id:       userId,
      transacao_id:  transacaoId || null,
      tipo_pergunta: tipoPergunta,
      contexto:      contexto || {},
    })
    .select()
    .single();

  if (error) {
    console.warn('[pendentes] erro ao criar:', error.message);
    return null;
  }
  return data;
}

/**
 * Busca a pendente ativa (não expirada) do user.
 */
async function buscarPendente(userId) {
  if (!userId) return null;

  const { data } = await supabase
    .from('transacoes_pendentes')
    .select('*')
    .eq('user_id', userId)
    .gte('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data;
}

/**
 * Remove a pendente (após resolver).
 */
async function removerPendente(id) {
  if (!id) return;
  await supabase.from('transacoes_pendentes').delete().eq('id', id);
}

module.exports = { criarPendente, buscarPendente, removerPendente };
