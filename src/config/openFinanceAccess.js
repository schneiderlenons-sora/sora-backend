// =====================================================================
// Allowlist do Open Finance (rollout fechado). Mantém em sincronia com o
// lib/open-finance-access.ts do frontend. Pra liberar mais alguém, adicione
// o e-mail (login) ou o número de WhatsApp aqui.
// =====================================================================
const supabase = require('../db/supabase');

const EMAILS = [
  'schneider.lenon.s@gmail.com',
  'schineiderlenon@gmail.com',
  'cassiopellegrim@gmail.com',
];
const PHONES = [
  '5511991774537',
];

const normPhone = (p) => (p || '').replace(/\D/g, '');

// Está liberado pro Open Finance? (checa e-mail e telefone do usuário)
async function liberadoOpenFinance(userId) {
  if (!userId) return false;
  const { data } = await supabase.from('users').select('email, phone').eq('id', userId).maybeSingle();
  if (!data) return false;
  const email = (data.email || '').trim().toLowerCase();
  const phone = normPhone(data.phone);
  return (!!email && EMAILS.includes(email)) || (!!phone && PHONES.includes(phone));
}

module.exports = { liberadoOpenFinance };
