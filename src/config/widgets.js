// ─────────────────────────────────────────────────────────────────────────────
// Widgets do iPhone e do Android — quem pode usar (decisão do dono, 25/11/2026).
//
// SÓ ASSINANTES, mensal E anual: Básico, Premium e Platinum com assinatura
// (Stripe, Play ou Apple). Vitalício, Kit, grátis e inativo ficam de fora — o
// widget mostra "Fora do seu plano" (no iPhone, sem oferta de compra nenhuma).
//
// TESTE FECHADO até o dono abrir: `WIDGETS_ABERTOS=1` no Render libera pra todo
// assinante. As contas da lista entram SEMPRE, com qualquer plano — a conta de
// testes (comercialsora) é vitalícia e ficaria de fora.
// Desligar tudo na hora (sem deploy): `WIDGETS_ATIVOS=0`.
// ─────────────────────────────────────────────────────────────────────────────
const { normalizarPlano } = require('./planos');

const EMAILS_TESTE = [
  'schneider.lenon.s@gmail.com',
  'schineiderlenon@gmail.com',
  'comercialsora@gmail.com',
];

const PLANOS_ASSINATURA = ['basico', 'premium', 'platinum'];

const ativos = () => process.env.WIDGETS_ATIVOS !== '0';
const abertos = () => process.env.WIDGETS_ABERTOS === '1';

/** Validade dos códigos de conexão (uso único). */
const CODIGO_TTL_S = 5 * 60;

/**
 * Esta conta pode usar os widgets?
 * @param {{ email?, plano?, vitalicio?, assinatura_stripe?, plano_fonte?, plano_valido_ate? }} u
 * @returns {{ ok: boolean, motivo?: 'desligado'|'teste'|'plano' }}
 */
function acessoWidget(u, agora = new Date()) {
  if (!ativos()) return { ok: false, motivo: 'desligado' };
  if (!u) return { ok: false, motivo: 'plano' };
  const email = String(u.email || '').trim().toLowerCase();
  if (EMAILS_TESTE.includes(email)) return { ok: true };
  if (!abertos()) return { ok: false, motivo: 'teste' };

  let plano = normalizarPlano(u.plano);
  // Mesma regra de vencimento do `exigirPlano` (lá ele também grava 'inativo').
  if (plano !== 'inativo' && plano !== 'gratis' && u.plano_valido_ate
      && new Date(u.plano_valido_ate) < agora) plano = 'inativo';
  if (!PLANOS_ASSINATURA.includes(plano)) return { ok: false, motivo: 'plano' };
  // ⚠️ Vitalício da Completa vira plano 'premium' — e NÃO é assinatura.
  if (u.vitalicio) return { ok: false, motivo: 'plano' };
  const temAssinatura = !!u.assinatura_stripe || ['play', 'apple'].includes(String(u.plano_fonte || ''));
  if (!temAssinatura) return { ok: false, motivo: 'plano' };
  return { ok: true };
}

module.exports = { EMAILS_TESTE, PLANOS_ASSINATURA, CODIGO_TTL_S, acessoWidget, ativos, abertos };
