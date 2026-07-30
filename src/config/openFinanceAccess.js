// =====================================================================
// Quem pode usar o Open Finance — e quantos bancos pode conectar.
//
// Era allowlist de e-mails (teste fechado com a Polp). Agora está ABERTO pra
// quem tem ASSINATURA RECORRENTE: Básico = 1 conexão, Premium/Black = 3.
// Vitalício NÃO entra: pagou uma vez e cada conexão nos custa mensalidade no
// agregador. Acima do limite seria +R$5/mês por conexão — a cobrança ainda não
// existe, então por ora o limite simplesmente bloqueia.
//
// ⚠️ Espelha `temOpenFinance` / `LIMITES.conexoes_of` do frontend
// (sora-frontend/lib/plans.ts). Mudou lá, mude aqui: se a tela liberar o que a
// API recusa, o usuário escolhe o banco, digita o CPF e só então toma 403.
//
// A allowlist continua valendo como ATALHO de teste (dono + convidados), pra
// validar banco novo sem depender do plano da conta.
// =====================================================================
const supabase = require('../db/supabase');

const EMAILS = [
  'schneider.lenon.s@gmail.com',
  'schineiderlenon@gmail.com',
  'anamarinalima891@gmail.com',
];
const PHONES = [];

// Planos com direito ao recurso × quantas conexões cada um leva.
const LIMITE_CONEXOES = { basico: 1, premium: 3, black: 3 };

const normPhone = (p) => (p || '').replace(/\D/g, '');

function naAllowlist(user) {
  const email = (user?.email || '').trim().toLowerCase();
  const phone = normPhone(user?.phone);
  return (!!email && EMAILS.includes(email)) || (!!phone && PHONES.includes(phone));
}

/**
 * Acesso ao Open Finance + limite de conexões do plano.
 * Devolve `{ liberado, limite, plano, motivo }`; `motivo` explica a recusa
 * ('plano' | 'vitalicio' | 'sem_usuario') pra tela dar a mensagem certa.
 */
async function acessoOpenFinance(userId) {
  if (!userId) return { liberado: false, limite: 0, plano: null, motivo: 'sem_usuario' };

  const { data } = await supabase.from('users')
    .select('email, phone, plano, vitalicio').eq('id', userId).maybeSingle();
  if (!data) return { liberado: false, limite: 0, plano: null, motivo: 'sem_usuario' };

  const plano = data.plano || 'inativo';

  // Atalho de teste: entra com o limite do Premium, seja qual for o plano.
  if (naAllowlist(data)) return { liberado: true, limite: LIMITE_CONEXOES.premium, plano, motivo: null };

  if (data.vitalicio) return { liberado: false, limite: 0, plano, motivo: 'vitalicio' };

  const limite = LIMITE_CONEXOES[plano] || 0;
  return { liberado: limite > 0, limite, plano, motivo: limite > 0 ? null : 'plano' };
}

/** Compat: só o booleano (onde o limite não importa). */
async function liberadoOpenFinance(userId) {
  return (await acessoOpenFinance(userId)).liberado;
}

module.exports = { acessoOpenFinance, liberadoOpenFinance, LIMITE_CONEXOES };
