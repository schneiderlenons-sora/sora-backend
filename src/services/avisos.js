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

// briefingLigado(userId) → true quando o usuário tem o briefing matinal ATIVO.
// Usado pra NÃO duplicar o "vence hoje": se o briefing está ligado, ele já lista
// o que vence hoje, então os crons por-item mandam só antecedência/atraso. Se
// desligado, os crons voltam a mandar "vence hoje" (fallback). Default: false
// (sem briefing → crons mandam tudo). Cache curto igual ao avisosLigados.
const cacheBrief = new Map();
async function briefingLigado(userId) {
  if (!userId) return false;
  const c = cacheBrief.get(userId);
  if (c && Date.now() - c.t < TTL) return c.v;
  let v = false;
  try {
    const { data } = await supabase.from('users')
      .select('agenda_briefing_ativo, agenda_briefing_horario').eq('id', userId).maybeSingle();
    if (data) v = data.agenda_briefing_ativo === true && !!data.agenda_briefing_horario;
  } catch { /* coluna ausente → briefing off */ }
  cacheBrief.set(userId, { v, t: Date.now() });
  return v;
}

// ─────────────────────────────────────────────────────────────────
// briefingCobriuCompromisso(userId, criadoEm, hojeStr)
//
// ⚠️ NÃO É `briefingLigado`. "Ligado" só diz que a pessoa recebe briefing;
// esta diz se o briefing DE HOJE chegou a mencionar ESTE item. A diferença
// custou o relato de 30/09/2026: compromisso criado 23 minutos depois do
// briefing teve o lembrete suprimido em nome de uma mensagem que não falava
// dele — e nada foi avisado. A regra mora em `services/briefingCobre.js`,
// com eval.
//
// Sem cache de propósito: o valor depende do `created_at` do ITEM, não só do
// usuário, então um cache por `userId` responderia errado para o segundo
// compromisso da mesma pessoa.
// ─────────────────────────────────────────────────────────────────
const { briefingCobriu } = require('./briefingCobre');

async function briefingCobriuCompromisso(userId, criadoEm, hojeStr) {
  if (!userId) return false;
  try {
    const { data } = await supabase.from('users')
      .select('agenda_briefing_ativo, agenda_briefing_horario, agenda_briefing_ultimo')
      .eq('id', userId).maybeSingle();
    if (!data || data.agenda_briefing_ativo !== true || !data.agenda_briefing_horario) return false;
    return briefingCobriu({
      briefingUltimo: data.agenda_briefing_ultimo,
      briefingHorario: data.agenda_briefing_horario,
      criadoEm,
      hojeStr,
    });
  } catch {
    // Falha de leitura → não afirma cobertura, e o lembrete sai. Perder o
    // aviso é justamente o defeito que esta função existe pra corrigir.
    return false;
  }
}

module.exports = { avisosLigados, briefingLigado, briefingCobriuCompromisso };
