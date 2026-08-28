// ─────────────────────────────────────────────────────────────────────────────
// Planos × acesso — ESPELHO do `sora-frontend/lib/plans.ts`.
//
// ⚠️ Mexeu num, mexa no outro. Se a tela liberar algo que a API recusa (ou o
// contrário), o usuário clica e leva 403 sem entender por quê.
//
// 'platinum' = tudo do Premium + aba Negócios + 5 conexões de Open Finance
//              + suporte prioritário. Nasceu na migration 142.
//
// ⚠️ 'black' FOI APOSENTADO (migration 142). Era idêntico ao Premium desde
// 2026. `normalizarPlano` cobre linha que escape da conversão — sem ela, um
// black esquecido perderia TODAS as features de uma vez.
// ─────────────────────────────────────────────────────────────────────────────

const PLANOS = ['inativo', 'basico', 'kit', 'premium', 'platinum'];

/** Black → premium (equivalentes desde sempre). Valor desconhecido → inativo. */
function normalizarPlano(plano) {
  if (plano === 'black') return 'premium';
  return PLANOS.includes(plano) ? plano : 'inativo';
}

/**
 * Aba Negócios liberada?
 *
 * ⚠️ NÃO É `plano === 'platinum'`. Três portas, nesta ordem:
 *  1. `negocios_liberado` — direito adquirido de quem já usava a aba quando ela
 *     saiu do Premium (migration 142 marcou os 69). Nunca revogado.
 *  2. Vitalício da COMPLETA — quem compra o vitalício leva Negócios junto
 *     "por enquanto". É REGRA, não backfill, pra valer nas compras novas.
 *     ⚠️ O KIT (R$47) FICA DE FORA. Ele também é vitalício, mas é o tier
 *     reduzido — sem WhatsApp, Grow, Open Finance e OCR — e Negócios é
 *     justamente o que o Platinum vende. Sem esta ressalva, 2 compradores de
 *     Kit ganhariam a aba de graça (medido antes de escrever a regra).
 *  3. Platinum.
 *
 * Recebe a LINHA do usuário — precisa de `plano`, `vitalicio` e
 * `negocios_liberado` juntos, então quem chama tem de trazer os três no select.
 */
function temNegocios(user) {
  if (!user) return false;
  if (user.negocios_liberado) return true;
  if (user.vitalicio && normalizarPlano(user.plano) !== 'kit') return true;
  return normalizarPlano(user.plano) === 'platinum';
}

/** Planos com acesso ao Sora Grow completo (saúde, estudos, casa, coleções). */
const GROW_COMPLETO = ['premium', 'platinum'];

/** Planos com acesso base ao Grow (hábitos, tarefas, agenda, bem-estar). */
const GROW_BASE = ['basico', 'premium', 'platinum'];

/** Premium ou acima — o degrau que libera OCR, Drive, compartilhamento etc. */
function ehPremiumOuAcima(plano) {
  return GROW_COMPLETO.includes(normalizarPlano(plano));
}

module.exports = {
  PLANOS,
  GROW_BASE,
  GROW_COMPLETO,
  normalizarPlano,
  temNegocios,
  ehPremiumOuAcima,
};
