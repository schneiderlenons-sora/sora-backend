// =============================================================================
// Nome da conta/cartão que chega pelo Open Finance numa CONEXÃO DE EMPRESA.
//
// Relato (Robert, out/2026): conectou a conta PJ do Mercado Pago, e como já
// havia a pessoal com o mesmo nome, a nova virou "Mercado Pago (OF)" — no meio
// das pessoais, sem nada dizendo "empresa". Ele leu como "não conectou" e
// desconectou a conta que estava funcionando.
//
// A Celcoin NÃO devolve se o consentimento é PJ (nem no show nem na conta: o
// `subtype` é INDIVIDUAL/CONJUNTA). A única hora em que sabemos é a conexão,
// quando a pessoa informa o CNPJ — por isso `of_conexoes.empresarial`
// (migration 188) e este nome.
//
// ⚠️ SÓ VALE PRA CARTEIRA NOVA. O sync nunca renomeia carteira existente (a
// pessoa pode ter renomeado à mão), e quem já tem a conta PJ conectada segue
// com o nome que tem.
// =============================================================================

const MAX = 60; // wallets.nome é cortado em 60 em todo o sync

// Já diz que é da empresa? Então não repete ("Itaú Empresas", "Conta PJ").
const JA_E_EMPRESA = /\b(pj|empresa|empresas|empresarial|business|negocios|negócios)\b/i;

/**
 * @param {string} nome  o nome que o sync daria (ex.: "Mercado Pago", "Itaú Crédito")
 * @param {{ empresarial?: boolean }} opcoes
 * @returns {string}
 */
function nomeDaContaOf(nome, { empresarial = false } = {}) {
  const base = String(nome || 'Conta').trim() || 'Conta';
  if (empresarial !== true) return base.slice(0, MAX);
  if (JA_E_EMPRESA.test(base)) return base.slice(0, MAX);

  // Cartão: "Mercado Pago Crédito" → "Mercado Pago PJ Crédito" (o banco fica
  // junto do PJ, como a pessoa fala). O resto ganha o PJ no fim.
  const m = base.match(/^(.*\S)(\s+cr[eé]dito)$/i);
  const comPj = m ? `${m[1]} PJ${m[2]}` : `${base} PJ`;
  if (comPj.length <= MAX) return comPj;
  // Corta o NOME, nunca o PJ: é a parte que distingue.
  return m
    ? `${m[1].slice(0, MAX - 3 - m[2].length)} PJ${m[2]}`
    : `${base.slice(0, MAX - 3)} PJ`;
}

/** A conexão é de empresa? `true` só com o fato gravado; null/ausente = não. */
function conexaoEmpresarial(conexao) {
  return !!(conexao && conexao.empresarial === true);
}

/** O CNPJ informado ao conectar tem dígitos de verdade? (só o FATO é gravado, nunca o número) */
function informouCnpj(cnpj) {
  return String(cnpj || '').replace(/\D/g, '').length === 14;
}

module.exports = { nomeDaContaOf, conexaoEmpresarial, informouCnpj };
