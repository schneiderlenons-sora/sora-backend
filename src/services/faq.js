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
  // ⚠️ Caso real (nov/2026, cliente vitalícia): "Mensalidade da IA cobrou no
  // crédito NuBank agora no valor de 107,54" recebeu a TABELA DE PREÇOS — o
  // "mensalidade" casou com o FAQ de planos e o gasto nunca foi lançado; e
  // "Já lançou a mensalidade da IA?" recebeu a tabela de novo. Mensagem com
  // VALOR EM DINHEIRO, ou falando de cobrança/débito que aconteceu, ou
  // perguntando se algo FOI lançado, é sobre o dinheiro da pessoa: segue pro
  // parser/IA. Pergunta de FAQ não traz valor com centavos. (eval:faq)
  if (/\d+[.,]\d{2}\b|r\$\s*\d/.test(msg)) return null;
  if (/\b(cobrou|cobraram|debitou|debitaram|descontou|descontaram|lancou|lancei|registrou|anotou)\b/.test(msg)) return null;

  for (const item of FAQ) {
    if (item.gatilhos.some((re) => re.test(msg))) return item.resposta;
  }
  return null;
}

module.exports = { responderFaq };
