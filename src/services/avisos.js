// =====================================================================
// Kill-switch dos avisos da Sora (coluna users.avisos_ativos).
// avisosLigados(userId) → false só quando o usuário desligou os avisos.
// Tolerante: se a coluna não existir (pré-migration 055) ou der erro, retorna
// true (comportamento atual). Cache curto (60s) pra não pesar nos crons.
// =====================================================================
const supabase = require('../db/supabase');

const cache = new Map(); // userId → { v, t }
const TTL = 60 * 1000;

async function avisosLigados(userId) {
  if (!userId) return true;
  const c = cache.get(userId);
  if (c && Date.now() - c.t < TTL) return c.v;
  let v = true;
  try {
    const { data } = await supabase.from('users').select('avisos_ativos').eq('id', userId).maybeSingle();
    if (data) v = data.avisos_ativos !== false;
  } catch { /* coluna ausente → mantém true */ }
  cache.set(userId, { v, t: Date.now() });
  return v;
}

module.exports = { avisosLigados };
