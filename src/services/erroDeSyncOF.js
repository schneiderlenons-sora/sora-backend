// =============================================================================
// O que o CLIENTE lê quando a sincronização do banco falha.
//
// `of_conexoes.ultimo_erro` guarda o motivo TÉCNICO (é o que o admin e o
// diagnóstico usam). Ele ia cru pra tela: "Celcoin GET /consents/<id>/
// credit-cards → 500". As frases que o próprio código já escreve pro cliente
// (autorização recusada, consentimento expirado) passam como estão.
// =============================================================================
const INSTAVEL = 'A ligação com o banco falhou na última tentativa. O que já veio continua salvo — a Sora tenta de novo, ou toque em Sincronizar em alguns minutos.';
const OUTRO = 'Não consegui atualizar na última tentativa. O que já veio continua salvo — toque em Sincronizar e, se continuar, fale com a gente.';

function erroDeSyncParaCliente(ultimoErro, status) {
  const texto = String(ultimoErro || '').trim();
  if (!texto) return null;
  if (/^Celcoin\b/.test(texto)) {
    return /→\s*(5\d\d|429|rede)\b/.test(texto) ? INSTAVEL : OUTRO;
  }
  // 'error' e 'updated' com texto = exceção gravada pelo sync (mensagem crua).
  const st = String(status || '').toLowerCase();
  return st === 'error' || st === 'updated' ? OUTRO : texto;
}

module.exports = { erroDeSyncParaCliente, INSTAVEL, OUTRO };
