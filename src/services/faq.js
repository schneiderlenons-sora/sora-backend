// =====================================================================
// Matcher do FAQ — local-first. Testa os gatilhos (regex ASCII) contra a
// mensagem normalizada (sem acento, minúscula). Retorna a resposta pronta
// ou null (aí o fluxo segue pro parser/IA).
// =====================================================================
const { FAQ } = require('../data/faq');

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

/**
 * Responde a perguntas comuns sem gastar IA. Não intercepta lançamentos de
 * transação (esses seguem pro parser/IA pra serem lançados).
 * @returns {string|null} resposta pronta ou null
 */
function responderFaq(mensagem) {
  const msg = normalizar(mensagem);
  if (msg.length < 3) return null;

  // Lançamentos têm prioridade — não interceptar com FAQ.
  if (/\b(gastei|paguei|comprei|recebi|ganhei|transferi)\b/.test(msg)) return null;

  for (const item of FAQ) {
    if (item.gatilhos.some((re) => re.test(msg))) return item.resposta;
  }
  return null;
}

module.exports = { responderFaq };
