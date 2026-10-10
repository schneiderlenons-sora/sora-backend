// =============================================================================
// CONVITE POR EMPRESA — regras puras (Fase 3 do Negócios multiusuário).
//
// A tabela `convites_empresa` (migration 173) existia sem nada que a usasse.
// Aqui ficam as decisões que NÃO tocam o banco — validade do convite e as
// guardas de remoção/papel — pra terem eval próprio. O I/O mora nas rotas.
//
// Plano: docs/PLANO-NEGOCIOS-MULTIUSUARIO.md (4.6 e 4.5).
// =============================================================================

const PAPEIS_CONVITE = ['admin', 'operador', 'leitura'];
const CONVITE_TTL_DIAS = 7;

/** Papel pedido no convite é válido? (espelha o CHECK da 173) */
function papelConviteValido(papel) {
  return PAPEIS_CONVITE.includes(String(papel || ''));
}

/** Quando um convite criado agora expira. */
function expiraEm(agora = new Date()) {
  return new Date(agora.getTime() + CONVITE_TTL_DIAS * 86400000).toISOString();
}

/**
 * O convite pode ser aceito AGORA? Devolve `{ ok, erro? }`.
 *
 * ⚠️ A ordem das recusas importa pra mensagem fazer sentido: inexistente →
 * "não encontrado" (código errado/digitado torto); já usado → "já usado" (não
 * reaproveita, senão vira link eterno de acesso); expirado → "expirou". Na
 * dúvida (sem data), trata como expirado — nunca aceita um convite que não dá
 * pra PROVAR que está no prazo.
 */
function conviteUtilizavel(convite, agora = new Date()) {
  if (!convite || !convite.id) return { ok: false, erro: 'Convite não encontrado.' };
  if (convite.usado) return { ok: false, erro: 'Este convite já foi usado.' };
  const exp = Date.parse(convite.expira_em);
  if (!Number.isFinite(exp) || exp < agora.getTime()) {
    return { ok: false, erro: 'Este convite expirou. Peça um novo.' };
  }
  return { ok: true };
}

/**
 * Pode remover (ou rebaixar) este membro?
 *
 * ⚠️ O DONO (`empresas.user_id`) NUNCA sai nem é rebaixado — nem pelo admin
 * convidado. Ele é quem responde pela empresa; tirá-lo deixaria a empresa sem
 * dono e sem quem a arquive. (Mesma linha de pensamento do `acessoEmpresa`, que
 * jamais rebaixa o dono pelo próprio vínculo.)
 *
 * @param donoUserId  empresas.user_id
 * @param alvoUserId  o membro que se quer remover/rebaixar
 */
function podeMexerNoMembro(donoUserId, alvoUserId) {
  if (!alvoUserId) return { ok: false, erro: 'Membro inválido.' };
  if (donoUserId && String(donoUserId) === String(alvoUserId)) {
    return { ok: false, erro: 'O dono da empresa não pode ser removido nem rebaixado.' };
  }
  return { ok: true };
}

module.exports = {
  PAPEIS_CONVITE, CONVITE_TTL_DIAS,
  papelConviteValido, expiraEm, conviteUtilizavel, podeMexerNoMembro,
};
