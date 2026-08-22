// =============================================================================
// arquivadas — transação escondida da visão do grupo (migration 131).
//
// Em gestão compartilhada tudo é do grupo. Arquivar tira um lançamento da vista
// de todos e o guarda numa aba que só quem arquivou enxerga: o presente de
// aniversário, ou a compra que o Open Finance puxou sozinho.
//
// ── O QUE ARQUIVAR SIGNIFICA ────────────────────────────────────────────────
// Sai de TUDO que é visão normal — lista, dashboard, resumo, categorias,
// relatórios, Wrapped e as respostas do WhatsApp. NÃO é "some da lista mas
// continua no total": isso deixaria a soma das linhas diferente do total
// exibido, que é o tipo de número mágico que já custou semanas de investigação
// na fatura do cartão.
//
// ⚠️ NÃO MEXE NO SALDO. O dinheiro saiu do banco de verdade e, em conta de Open
// Finance, o saldo vem do próprio banco. Arquivar é decisão de EXIBIÇÃO.
//
// ⚠️ FALHA ABERTA, de propósito. Esquecer o filtro em algum ponto faz a
// transação apenas continuar aparecendo — ninguém vê nada que já não pudesse
// ver. Foi o que fez esta versão ser escolhida no lugar de uma "transação
// privada" de verdade, onde um filtro esquecido vazaria gasto íntimo.
// =============================================================================
const supabase = require('../db/supabase');

// ⚠️ SONDA. Filtrar por coluna que não existe faz o Supabase falhar o SELECT
// INTEIRO e devolver vazio — a lista de transações sumiria pra todo mundo
// enquanto a migration 131 não rodasse. Por isso perguntamos antes.
//
// ⚠️ O "NÃO" TEM VALIDADE, O "SIM" NÃO. Cachear o negativo pra sempre foi um
// bug real: o servidor subiu ANTES da migration, sondou, guardou "não existe" e
// nunca mais perguntou — a pessoa rodava a 131, arquivava a transação (gravava
// certo no banco!) e ela voltava a aparecer, porque a leitura seguia sem filtro
// até alguém reiniciar o Render.
//
// Coluna não desaparece, então o "sim" pode ser eterno. O "não" é reconferido a
// cada minuto: depois da migration o recurso liga sozinho, sem deploy.
const TTL_NEGATIVO = 60 * 1000;
let _suportado = null;
let _checadoEm = 0;
async function suportado() {
  if (_suportado === true) return true;
  if (_suportado === false && Date.now() - _checadoEm < TTL_NEGATIVO) return false;
  const { error } = await supabase.from('transacoes').select('arquivada_por').limit(1);
  _suportado = !error;
  _checadoEm = Date.now();
  if (!_suportado) console.warn('[arquivadas] coluna ausente — migration 131 pendente; filtro desligado');
  return _suportado;
}

/**
 * Aplica o filtro numa query de `transacoes`.
 *
 * @param {object} query   query do supabase-js já montada
 * @param {object} opts
 *   - `userId`     quem está olhando
 *   - `mostrar`    'nenhuma' (padrão — esconde as arquivadas)
 *                | 'minhas'  (SÓ as que EU arquivei — é a aba Arquivadas)
 */
async function filtrar(query, { userId, mostrar = 'nenhuma' } = {}) {
  if (!(await suportado())) return query;
  if (mostrar === 'minhas') {
    // ⚠️ Sem `userId` isto devolveria as arquivadas DO OUTRO membro. Nesse caso
    // é mais seguro não devolver nada.
    return userId ? query.eq('arquivada_por', userId) : query.eq('arquivada_por', '00000000-0000-0000-0000-000000000000');
  }
  return query.is('arquivada_por', null);
}

/** Versão sem `await` pra quem já sabe que a coluna existe (loops quentes). */
function ehArquivada(tx) {
  return !!(tx && tx.arquivada_por);
}

module.exports = { filtrar, suportado, ehArquivada };
