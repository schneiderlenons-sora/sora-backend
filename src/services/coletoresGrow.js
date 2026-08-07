// =====================================================================
// Coletores do Grow pros resumos proativos (semanal/mensal).
//
// Cada `coletarX` devolve um resumo estruturado do período OU `null`. A
// regra que decide null é "o usuário NUNCA usou essa aba" (zero linhas em
// TODA a história, não só no período) — é o que faz o resumo incluir só o
// que a pessoa realmente usa ("CASO O USUÁRIO UTILIZE", pedido do usuário).
// Se o cadastro existe mas o período ficou zerado, o coletor devolve os
// zeros mesmo assim — quem decide se vale mencionar isso (ex.: "você não
// treinou essa semana") é o prompt do insight, não aqui.
//
// Tudo por user_id (Hábitos/Tarefas/Treino/Estudos são SEMPRE privados, nunca
// por grupo — mesma regra do resto do Grow, ver CLAUDE.md "Privacidade do
// Grow em grupos").
// =====================================================================
const supabase = require('../db/supabase');

/** Quantos dias tem o intervalo [ini, fim). */
function diasNoPeriodo(ini, fim) {
  const a = new Date(`${ini}T12:00:00Z`);
  const b = new Date(`${fim}T12:00:00Z`);
  return Math.max(1, Math.round((b - a) / 86400000));
}

// ── Hábitos ──────────────────────────────────────────────────────────
async function coletarHabitos(userId, ini, fim) {
  const { data: habitos } = await supabase.from('habitos')
    .select('id, nome').eq('user_id', userId).eq('ativo', true);
  if (!habitos?.length) return null;

  const ids = habitos.map((h) => h.id);
  const { data: regs } = await supabase.from('registros_habito')
    .select('habito_id, concluido, data')
    .eq('user_id', userId).in('habito_id', ids)
    .gte('data', ini).lt('data', fim);

  const feitos = (regs || []).filter((r) => r.concluido);
  const porHabito = new Map();
  for (const r of feitos) porHabito.set(r.habito_id, (porHabito.get(r.habito_id) || 0) + 1);

  const dias = diasNoPeriodo(ini, fim);
  // "Perfeito" = todo hábito ativo foi marcado em TODOS os dias do período —
  // é o gancho pro "parabéns, treinou/fez tudo todo dia" que o usuário pediu.
  const perfeito = habitos.length > 0 && habitos.every((h) => (porHabito.get(h.id) || 0) >= dias);
  let melhor = null;
  for (const h of habitos) {
    const n = porHabito.get(h.id) || 0;
    if (!melhor || n > melhor.n) melhor = { nome: h.nome, n };
  }

  return {
    ativos: habitos.length,
    checkins: feitos.length,
    possiveis: habitos.length * dias,
    taxa: habitos.length * dias > 0 ? Math.round((feitos.length / (habitos.length * dias)) * 100) : 0,
    perfeito,
    melhorHabito: melhor?.nome || null,
  };
}

// ── Tarefas ──────────────────────────────────────────────────────────
async function coletarTarefas(userId, ini, fim) {
  const { data: alguma } = await supabase.from('tarefas')
    .select('id').eq('user_id', userId).limit(1);
  if (!alguma?.length) return null;

  const { data: concluidas } = await supabase.from('tarefas')
    .select('id, titulo').eq('user_id', userId).eq('concluida', true)
    .gte('updated_at', `${ini}T00:00:00`).lt('updated_at', `${fim}T00:00:00`);
  const { data: criadas } = await supabase.from('tarefas')
    .select('id').eq('user_id', userId)
    .gte('created_at', `${ini}T00:00:00`).lt('created_at', `${fim}T00:00:00`);
  const { count: pendentes } = await supabase.from('tarefas')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('concluida', false);

  return {
    concluidas: concluidas?.length || 0,
    criadas: criadas?.length || 0,
    pendentes: pendentes || 0,
    destaque: concluidas?.[0]?.titulo || null,
  };
}

// ── Treino ───────────────────────────────────────────────────────────
async function coletarTreino(userId, ini, fim) {
  const { data: alguma } = await supabase.from('treino_registros')
    .select('id').eq('user_id', userId).limit(1);
  if (!alguma?.length) return null;

  const { data: regs } = await supabase.from('treino_registros')
    .select('data, duracao_min, calorias_kcal, treino_nome')
    .eq('user_id', userId).gte('data', ini).lt('data', fim);

  const dias = diasNoPeriodo(ini, fim);
  const diasTreinados = new Set((regs || []).map((r) => String(r.data).slice(0, 10))).size;
  const tipos = {};
  for (const r of regs || []) tipos[r.treino_nome || 'Treino'] = (tipos[r.treino_nome || 'Treino'] || 0) + 1;
  const tipoTop = Object.entries(tipos).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    sessoes: regs?.length || 0,
    minutos: (regs || []).reduce((s, r) => s + (r.duracao_min || 0), 0),
    calorias: (regs || []).reduce((s, r) => s + (r.calorias_kcal || 0), 0),
    diasTreinados,
    diasNoPeriodo: dias,
    todosDias: diasTreinados >= dias,      // gancho pro "treinou todo dia, parabéns"
    tipoTop,
  };
}

// ── Estudos ──────────────────────────────────────────────────────────
async function coletarEstudos(userId, ini, fim) {
  const { data: alguma } = await supabase.from('sessoes_estudo')
    .select('id').eq('user_id', userId).limit(1);
  if (!alguma?.length) return null;

  const { data: regs } = await supabase.from('sessoes_estudo')
    .select('duracao_min, disciplina_id').eq('user_id', userId).gte('data', ini).lt('data', fim);

  const porDisciplina = {};
  for (const r of regs || []) {
    if (!r.disciplina_id) continue;
    porDisciplina[r.disciplina_id] = (porDisciplina[r.disciplina_id] || 0) + (r.duracao_min || 0);
  }
  let disciplinaForte = null;
  const topId = Object.entries(porDisciplina).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topId) {
    const { data: d } = await supabase.from('disciplinas').select('nome').eq('id', topId).maybeSingle();
    disciplinaForte = d?.nome || null;
  }

  return {
    sessoes: regs?.length || 0,
    minutos: (regs || []).reduce((s, r) => s + (r.duracao_min || 0), 0),
    disciplinaForte,
  };
}

/**
 * Roda os 4 coletores em paralelo e devolve só os que têm cadastro (não-null).
 * `{}` quando o usuário não usa NENHUMA aba do Grow — o chamador trata isso
 * como "sem seção de Grow no resumo", sem quebrar nada.
 */
async function coletarGrow(userId, ini, fim) {
  const [habitos, tarefas, treino, estudos] = await Promise.all([
    coletarHabitos(userId, ini, fim).catch(() => null),
    coletarTarefas(userId, ini, fim).catch(() => null),
    coletarTreino(userId, ini, fim).catch(() => null),
    coletarEstudos(userId, ini, fim).catch(() => null),
  ]);
  const out = {};
  if (habitos) out.habitos = habitos;
  if (tarefas) out.tarefas = tarefas;
  if (treino) out.treino = treino;
  if (estudos) out.estudos = estudos;
  return out;
}

module.exports = {
  diasNoPeriodo, coletarHabitos, coletarTarefas, coletarTreino, coletarEstudos, coletarGrow,
};
