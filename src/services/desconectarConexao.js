// =============================================================================
// DESCONECTAR UMA CONEXÃO DE OPEN FINANCE — fonte única.
//
// Era inline na rota `DELETE /api/openfinance/conexoes/:externalId`. Virou
// serviço quando o cron de excedente (JOB 1R) passou a precisar do MESMO
// caminho: histórico guardado + consentimento revogado no provedor + linha
// apagada. Duas cópias divergentes aqui significariam conexão apagada da nossa
// base e viva na Polp — ou seja, cobrada pra sempre sem nada na tela.
//
// ⚠️ A ORDEM MUDA CONFORME QUEM MANDA, e isso é deliberado:
//
//   · USUÁRIO (`exigirRevogacao: false`) — apaga primeiro. Quando a pessoa toca
//     em "Desconectar", o banco TEM de sair da tela dela; uma falha de rede no
//     provedor não pode prender o banco no painel. É o comportamento que a rota
//     sempre teve.
//
//   · NÓS (`exigirRevogacao: true`) — revoga primeiro e só apaga se der certo.
//     Aqui o objetivo é PARAR DE PAGAR: apagar a linha sem revogar perderia o
//     rastro do consentimento e a Polp seguiria cobrando, que é exatamente o
//     problema que o corte existe pra resolver. Falhou? Não faz nada e tenta de
//     novo no próximo passe.
// =============================================================================

const supabase = require('../db/supabase');
const providers = require('./openFinanceProvider');

/**
 * Guarda a conexão no histórico antes de apagá-la.
 *
 * ⚠️ TOLERANTE (migration 129). A fatura da Polp cobra por consentimento ativo
 * NO CICLO, então uma conexão que viveu 20 dias e saiu continua cobrada naquele
 * mês — sem este registro não há como conferir a conta deles. Mas perder o
 * histórico é bem menos grave que impedir alguém de desconectar o banco.
 */
async function arquivar(c, motivo) {
  try {
    await supabase.from('of_conexoes_historico').insert({
      grupo_id: c.grupo_id, user_id: c.user_id || null,
      provider: c.provider, external_id: String(c.external_id),
      instituicao: c.instituicao || null, status_final: c.status || null,
      criada_em: c.created_at || null, motivo: motivo || 'usuario',
    });
  } catch { /* migration 129 pendente */ }
}

/**
 * @param {Object}  p
 * @param {Object}  p.conexao  linha de `of_conexoes` (precisa de id, provider, external_id)
 * @param {string}  [p.motivo] 'usuario' | 'excedente' | ...  (vai pro histórico)
 * @param {boolean} [p.exigirRevogacao] true = só apaga se o provedor revogar
 * @returns {Promise<{ ok: boolean, revogada: boolean, erro?: string }>}
 */
async function desconectarConexao({ conexao: c, motivo = 'usuario', exigirRevogacao = false } = {}) {
  if (!c || !c.external_id) return { ok: false, revogada: false, erro: 'conexão inválida' };
  const prov = providers.para(c.provider);

  if (exigirRevogacao) {
    try {
      await prov.removerConexao(String(c.external_id));
    } catch (e) {
      // Não apaga nada: o consentimento segue vivo lá e a linha segue aqui, que
      // é o único estado em que a próxima tentativa ainda sabe o que fazer.
      return { ok: false, revogada: false, erro: e.message };
    }
    await arquivar(c, motivo);
    await supabase.from('of_conexoes').delete().eq('id', c.id);
    return { ok: true, revogada: true };
  }

  await arquivar(c, motivo);
  await supabase.from('of_conexoes').delete().eq('id', c.id);
  await prov.removerConexao(String(c.external_id));   // erro sobe (comportamento da rota)
  return { ok: true, revogada: true };
}

module.exports = { desconectarConexao };
