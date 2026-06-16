// =====================================================================
// Agenda — feed unificado (Fase 2/3)
//
// Agrega num só lugar tudo que tem data na Sora: compromissos nativos +
// consultas/retornos + contas/receitas fixas + dívidas + faturas de cartão
// + manutenções. Usado pela rota GET /agenda/feed e pelo briefing matinal.
//
// Cada fonte é tolerante: se a tabela/coluna não existir, segue com as
// demais. Só `compromisso` é editável; o resto é read-only (deeplink).
// =====================================================================
const supabase = require('../db/supabase');

function isoLocal(d) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}

// Datas em que um "dia do mês" (1-31) cai dentro de [de, ate] — eventos
// mensais (vencimentos, faturas). Ajusta pro último dia em meses curtos.
function ocorrenciasMensais(dia, deStr, ateStr) {
  if (!dia) return [];
  const de = new Date(deStr + 'T12:00:00'), ate = new Date(ateStr + 'T12:00:00');
  const out = [];
  let y = de.getFullYear(), m = de.getMonth();
  while (new Date(y, m, 1) <= ate) {
    const ultimoDia = new Date(y, m + 1, 0).getDate();
    const d = new Date(y, m, Math.min(dia, ultimoDia), 12);
    if (d >= de && d <= ate) out.push(isoLocal(d));
    m++; if (m > 11) { m = 0; y++; }
  }
  return out;
}

// opts = { userId, casaCompartilhada }. Compromissos e consultas são pessoais
// (filtram por userId quando informado). Manutenções (Casa) seguem o toggle do
// grupo. Recorrências/dívidas/faturas são finanças → sempre por grupo.
async function montarFeed(grupoId, deStr, ateStr, opts = {}) {
  const { userId = null, casaCompartilhada = false, incluirTransacoes = false } = opts;
  const eventos = [];

  // 1. Compromissos nativos (editáveis) — pessoais
  try {
    let q = supabase.from('compromissos').select('*')
      .gte('data', deStr).lte('data', ateStr);
    q = userId ? q.eq('user_id', userId) : q.eq('grupo_id', grupoId);
    const { data } = await q;
    for (const c of data || []) eventos.push({
      id: `comp-${c.id}`, source: 'compromisso', titulo: c.titulo, data: c.data, hora: c.hora || null,
      cor: c.cor || '#7c3aed', local: c.local || null, deeplink: '/grow/agenda', editavel: true, raw: c,
    });
  } catch {}

  // 2. Consultas + retornos (Saúde)
  try {
    let qc = supabase.from('consultas')
      .select('id, profissional, especialidade, data, hora, local, retorno_data, status');
    qc = userId ? qc.eq('user_id', userId) : qc.eq('grupo_id', grupoId);
    const { data } = await qc;
    for (const c of data || []) {
      if (c.status === 'cancelada') continue;
      if (c.data >= deStr && c.data <= ateStr) {
        const nome = c.especialidade || c.profissional || 'Consulta';
        eventos.push({ id: `cons-${c.id}`, source: 'consulta', titulo: `Consulta: ${nome}`, data: c.data,
          hora: c.hora || null, cor: '#0d9488', local: c.local || c.profissional || null, deeplink: '/grow/saude', editavel: false });
      }
      if (c.retorno_data && c.retorno_data >= deStr && c.retorno_data <= ateStr) {
        eventos.push({ id: `ret-${c.id}`, source: 'consulta', titulo: `Retorno: ${c.especialidade || c.profissional || ''}`.trim(),
          data: c.retorno_data, hora: null, cor: '#0d9488', deeplink: '/grow/saude', editavel: false });
      }
    }
  } catch {}

  // 3. Recorrências (contas e receitas fixas)
  try {
    const { data } = await supabase.from('recorrencias')
      .select('id, tipo, descricao, valor, dia_vencimento, ativa').eq('grupo_id', grupoId).eq('ativa', true);
    for (const r of data || []) {
      const desp = r.tipo !== 'receita';
      for (const d of ocorrenciasMensais(r.dia_vencimento, deStr, ateStr)) {
        eventos.push({ id: `rec-${r.id}-${d}`, source: 'recorrencia',
          titulo: r.descricao || (desp ? 'Conta fixa' : 'Receita fixa'), data: d, hora: null,
          cor: desp ? '#dc2626' : '#16a34a', valor: r.valor || null, deeplink: '/transacoes', editavel: false });
      }
    }
  } catch {}

  // 4. Dívidas (parcela do mês)
  try {
    const { data } = await supabase.from('dividas')
      .select('id, titulo, valor_parcela, dia_vencimento, status').eq('grupo_id', grupoId).not('dia_vencimento', 'is', null);
    for (const dv of data || []) {
      if (dv.status === 'quitada') continue;
      for (const d of ocorrenciasMensais(dv.dia_vencimento, deStr, ateStr)) {
        eventos.push({ id: `div-${dv.id}-${d}`, source: 'divida', titulo: `Dívida: ${dv.titulo}`, data: d, hora: null,
          cor: '#ea580c', valor: dv.valor_parcela || null, deeplink: '/dividas', editavel: false });
      }
    }
  } catch {}

  // 5. Cartões — fatura: fecha + vence
  try {
    const { data } = await supabase.from('wallets')
      .select('id, nome, dia_fechamento, dia_vencimento').eq('grupo_id', grupoId);
    for (const w of data || []) {
      for (const d of ocorrenciasMensais(w.dia_vencimento, deStr, ateStr))
        eventos.push({ id: `fat-${w.id}-${d}`, source: 'fatura', titulo: `Fatura ${w.nome} vence`, data: d, hora: null,
          cor: '#2563eb', deeplink: '/cartao-de-credito', editavel: false });
      for (const d of ocorrenciasMensais(w.dia_fechamento, deStr, ateStr))
        eventos.push({ id: `fec-${w.id}-${d}`, source: 'fechamento', titulo: `Fecha fatura ${w.nome}`, data: d, hora: null,
          cor: '#60a5fa', deeplink: '/cartao-de-credito', editavel: false });
    }
  } catch {}

  // 6. Manutenções (próxima prevista)
  try {
    let qm = supabase.from('manutencoes')
      .select('id, nome, icone, frequencia_dias, ultima_data').not('ultima_data', 'is', null);
    qm = (casaCompartilhada || !userId) ? qm.eq('grupo_id', grupoId) : qm.eq('user_id', userId);
    const { data } = await qm;
    for (const mn of data || []) {
      const prox = new Date(mn.ultima_data + 'T12:00:00');
      prox.setDate(prox.getDate() + (mn.frequencia_dias || 90));
      const ds = isoLocal(prox);
      if (ds >= deStr && ds <= ateStr)
        eventos.push({ id: `man-${mn.id}`, source: 'manutencao', titulo: `Manutenção: ${mn.nome}`, data: ds, hora: null,
          cor: '#d97706', deeplink: '/grow/casa', editavel: false });
    }
  } catch {}

  // 7. Transações (gastos/receitas) — OPT-IN. Só a agenda pede isso; o briefing
  //    matinal NÃO (senão listaria cada gasto do dia). Finanças = por grupo.
  if (incluirTransacoes) {
    try {
      const { data } = await supabase.from('transacoes')
        .select('id, tipo, categoria, valor, data, observacao')
        .eq('grupo_id', grupoId)
        .gte('data', deStr).lte('data', ateStr + 'T23:59:59.999')
        .order('data', { ascending: false })
        .limit(1000);
      for (const t of data || []) {
        const gasto = t.tipo === 'Gasto';
        const dia = String(t.data).slice(0, 10); // agrupa por dia (YYYY-MM-DD)
        const desc = String(t.observacao || t.categoria || '').replace(/\p{Emoji}/gu, '').trim();
        eventos.push({
          id: `tx-${t.id}`, source: 'transacao', tipo: gasto ? 'gasto' : 'receita',
          titulo: desc || (gasto ? 'Gasto' : 'Receita'), categoria: t.categoria || null,
          data: dia, hora: null, cor: gasto ? '#dc2626' : '#16a34a',
          valor: t.valor || 0, deeplink: '/transacoes', editavel: false,
        });
      }
    } catch {}
  }

  return eventos;
}

module.exports = { montarFeed, isoLocal, ocorrenciasMensais };
