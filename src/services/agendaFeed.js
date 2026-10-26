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
  const { userId = null, casaCompartilhada = false, incluirTransacoes = false, paraBriefing = false } = opts;
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

  // 3. Recorrências (contas e receitas fixas) — FORA do briefing: elas são
  //    lançadas automaticamente (JOB 1A) e já mandam a confirmação; listá-las no
  //    briefing como "agenda de hoje" duplicava a mesma info. Seguem na agenda
  //    VISUAL do painel (paraBriefing=false).
  //
  //    ⚠️ AS DATAS E O ESTADO SAEM DE services/ocorrenciasFixas.js — a MESMA
  //    regra do "o que tenho pra pagar" do WhatsApp. Antes daqui saía só o dia
  //    do vencimento, mês a mês: conta já paga seguia "a pagar" (relato do
  //    Fábio, out/2026), a pulada aparecia, a adiada ficava na data velha, a
  //    semanal aparecia uma vez por mês e a encerrada aparecia pra sempre.
  //    Paga não some: vem com `pago: true` e a tela mostra "Paga"/"Recebida".
  //
  //    ⚠️ BAIXA E AJUSTE SÃO LIDOS DE FORMA TOLERANTE: se a leitura falhar, a
  //    conta aparece como antes (em aberto). Esconder ou marcar "paga" por
  //    falta de dado é o erro que não se perdoa.
  if (!paraBriefing) {
    try {
      const { ocorrenciasDeFixas } = require('./ocorrenciasFixas');
      let { data: recs, error } = await supabase.from('recorrencias')
        .select('id, tipo, descricao, valor, dia_vencimento, frequencia, dia_semana, mes_vencimento, data_inicio, data_fim, ativa')
        .eq('grupo_id', grupoId).eq('ativa', true);
      // Coluna de frequência faltando (migration antiga) → lê como sempre leu;
      // sem `frequencia` o `venceHoje` trata tudo como mensal.
      if (error) {
        ({ data: recs } = await supabase.from('recorrencias')
          .select('id, tipo, descricao, valor, dia_vencimento, ativa').eq('grupo_id', grupoId).eq('ativa', true));
      }
      recs = recs || [];

      let ajustes = [];
      let vinculadas = [];
      if (recs.length) {
        try {
          const { data, error: e } = await supabase.from('previsao_ajustes')
            .select('recorrencia_id, competencia, status, nova_data, novo_valor').eq('grupo_id', grupoId);
          if (!e) ajustes = data || [];
        } catch {}
        // Competências do período + as das ADIADAS que caem nele (uma conta de
        // setembro adiada pra outubro precisa da baixa de SETEMBRO).
        const comps = new Set();
        let [y, m] = deStr.slice(0, 7).split('-').map(Number);
        for (let c = deStr.slice(0, 7); c <= ateStr.slice(0, 7); ) {
          comps.add(c);
          m += 1; if (m > 12) { m = 1; y += 1; }
          c = `${y}-${String(m).padStart(2, '0')}`;
        }
        for (const a of ajustes) {
          const nd = String(a.nova_data || '').slice(0, 10);
          if (a.status === 'movido' && nd >= deStr && nd <= ateStr && a.competencia) comps.add(a.competencia);
        }
        try {
          const { data, error: e } = await supabase.from('transacoes').select('recorrencia_id, competencia')
            .eq('grupo_id', grupoId).not('recorrencia_id', 'is', null)
            .in('competencia', [...comps]);
          if (!e) vinculadas = data || [];
        } catch {}
      }

      // Teto de dias: a janela padrão da rota é ~7 meses; 400 cobre com folga.
      const ocorr = ocorrenciasDeFixas({ recorrencias: recs, vinculadas, ajustes },
        { de: deStr, ate: ateStr }, { maxDias: 400 });
      for (const o of ocorr) {
        const r = o.rec;
        // ⚠️ `recorrencias.tipo` é 'Gasto' ou 'Recebimento' — NUNCA 'receita'.
        // Comparando com 'receita', `desp` dava sempre true e as 95 receitas
        // fixas da base apareciam VERMELHAS na agenda, rotuladas "Conta fixa"
        // quando não tinham descrição. Achado ao construir o Oráculo, que lê
        // essa mesma coluna.
        const desp = r.tipo !== 'Recebimento';
        // A adiada pode cair no MESMO dia da ocorrência do mês seguinte (adiar a
        // de setembro pro dia 25 de outubro) — sem o sufixo, duas chaves iguais.
        const id = o.adiada ? `rec-${r.id}-${o.data}-de-${o.competencia}` : `rec-${r.id}-${o.data}`;
        eventos.push({ id, source: 'recorrencia',
          titulo: r.descricao || (desp ? 'Conta fixa' : 'Receita fixa'), data: o.data, hora: null,
          cor: desp ? '#dc2626' : '#16a34a', valor: o.valorAjustado ?? o.valor ?? null,
          deeplink: '/transacoes', editavel: false,
          pago: o.estado === 'paga', adiada: o.adiada, receita: !desp });
      }
    } catch {}
  }

  // 4. Dívidas (parcela do mês)
  try {
    const { data } = await supabase.from('dividas')
      .select('id, titulo, valor_parcela, dia_vencimento, status, data_inicio').eq('grupo_id', grupoId).not('dia_vencimento', 'is', null);
    // Parcela já paga não aparece mais na agenda nem no briefing (mesma regra
    // do card e do lembrete — services/vencimentoDivida.js).
    const { vencimentoCoberto } = require('./vencimentoDivida');
    const ultimoPg = await require('./vencimentoDivida')
      .ultimoPagamentoPorDivida((data || []).map((d) => d.id));
    for (const dv of data || []) {
      if (dv.status === 'quitada') continue;
      const pago = ultimoPg[dv.id];
      const coberta = pago ? vencimentoCoberto(pago, dv.dia_vencimento) : null;
      for (const d of ocorrenciasMensais(dv.dia_vencimento, deStr, ateStr)) {
        // 1ª parcela nunca vence no mês da compra — pula a ocorrência em/antes
        // do data_inicio (senão o parcelado aparece vencendo 1 dia após comprar).
        if (dv.data_inicio && d <= dv.data_inicio) continue;
        if (coberta && d === coberta) continue;   // essa parcela já foi paga
        eventos.push({ id: `div-${dv.id}-${d}`, source: 'divida', titulo: `Dívida: ${dv.titulo}`, data: d, hora: null,
          cor: '#ea580c', valor: dv.valor_parcela || null, deeplink: '/dividas', editavel: false });
      }
    }
  } catch {}

  // 5. Cartões — fatura: fecha + vence.
  //    Só tipo 'Crédito' (antes qualquer wallet com esses dias virava evento) e
  //    o vencimento leva o VALOR da fatura daquele ciclo, pra a agenda e o
  //    briefing mostrarem quanto vai vencer.
  try {
    const { statusFatura } = require('./faturaRollover');
    const { valorExibido } = require('./faturaVista');
    const { competenciaAtual, cicloPorCompetencia } = require('./cicloFatura');
    const { data } = await supabase.from('wallets')
      .select('id, nome, saldo, of_conta_id, dia_fechamento, dia_vencimento, moeda')
      .eq('grupo_id', grupoId).eq('tipo', 'Crédito');

    // ⚠️ O valor do evento vai NA MOEDA DO GRUPO (migration 168): a agenda
    // formata todo evento com a moeda base, e a fatura de um cartão em outra
    // moeda sairia com o símbolo errado. Sem câmbio o evento fica sem valor
    // (ele já é tolerante a isso). Cartão na base: nada muda, nem ida de rede.
    const { moedaBaseDoGrupo, taxasParaBase, taxaEntre, normalizarMoeda } = require('./moeda');
    const cartoesForaDaBase = [];
    let baseGrupo = null;
    if ((data || []).length) {
      baseGrupo = await moedaBaseDoGrupo(grupoId);
      for (const w of data) if (normalizarMoeda(w.moeda) !== baseGrupo) cartoesForaDaBase.push(w.moeda);
    }
    let tabelaCartoes = {};
    if (cartoesForaDaBase.length) {
      try { tabelaCartoes = await taxasParaBase(cartoesForaDaBase, baseGrupo); } catch { tabelaCartoes = {}; }
    }

    for (const w of data || []) {
      // Valor da fatura em aberto (só o vencimento mais próximo — não vale a
      // pena somar ciclo a ciclo pra um feed que pode varrer meses) + se ela
      // já foi QUITADA. `valorExibido` é a mesma fonte única do painel
      // (services/faturaVista.js) — nunca reinventar a conta aqui.
      let valorFatura = null;
      let quitada = false;
      try {
        const comp = competenciaAtual(w);
        const st = await statusFatura(grupoId, w, comp);
        // A MESMA dep da rota de faturas: sem ela a agenda mostraria a fatura
        // sem as parcelas que só o banco conhece, divergindo do painel.
        const { lerPrevistas } = require('./parcelasPrevistas');
        const vista = await valorExibido(w, comp, st, { parcelasPrevistas: lerPrevistas });
        valorFatura = vista.restante || null;
        if (valorFatura !== null && normalizarMoeda(w.moeda) !== baseGrupo) {
          const t = taxaEntre(w.moeda, baseGrupo, tabelaCartoes);
          valorFatura = t === null ? null : Math.round(valorFatura * t * 100) / 100;
        }
        quitada = !!vista.quitada;
      } catch { /* tolerante: o evento vale mesmo sem o valor */ }
      const vencAtual = (() => {
        try { return cicloPorCompetencia(w, competenciaAtual(w)).venc; } catch { return null; }
      })();

      for (const d of ocorrenciasMensais(w.dia_vencimento, deStr, ateStr)) {
        // ⚠️ Fatura já PAGA não entra na agenda nem no briefing — mesma regra
        // que já existia pras dívidas, só não tinha chegado aqui ainda (bug
        // real: usuário recebeu "fatura vence hoje" de uma fatura que já
        // tinha pago). Só se aplica ao vencimento ATUAL: ocorrências
        // passadas/futuras não têm como saber se "serão" quitadas.
        if (d === vencAtual && quitada) continue;
        eventos.push({ id: `fat-${w.id}-${d}`, source: 'fatura', titulo: `Fatura ${w.nome} vence`, data: d, hora: null,
          cor: '#2563eb', valor: d === vencAtual ? valorFatura : null,
          deeplink: '/cartao-de-credito', editavel: false });
      }
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

  // 6B. Tarefas com prazo.
  //
  // ⚠️ TAREFA É SEMPRE PRIVADA — filtra por `user_id`, nunca por `grupo_id`.
  // Diferente de Casa/Manutenções, ela não tem toggle de compartilhamento (é a
  // regra registrada em "Privacidade do Grow em grupos"): num casal, a lista de
  // tarefas de um não pode vazar pra agenda do outro.
  //
  // Só entra tarefa NÃO concluída — a agenda é sobre o que ainda vai acontecer;
  // tarefa feita virando evento entulharia o dia com o que já saiu do caminho.
  //
  // Prioridade dá a cor, porque é o que a pessoa usa pra decidir a ordem do dia.
  try {
    if (userId) {
      const CORES_PRI = { urgente: '#ef4444', alta: '#f97316', media: '#eab308', baixa: '#22c55e' };
      const { data } = await supabase.from('tarefas')
        .select('id, titulo, prioridade, data_vencimento, projeto_id, projetos(nome, cor, icone)')
        .eq('user_id', userId)
        .eq('concluida', false)
        .not('data_vencimento', 'is', null)
        .gte('data_vencimento', deStr).lte('data_vencimento', ateStr);
      for (const t of data || []) {
        eventos.push({
          id: `tar-${t.id}`, source: 'tarefa',
          titulo: `Tarefa: ${t.titulo}`,
          data: String(t.data_vencimento).slice(0, 10), hora: null,
          cor: CORES_PRI[t.prioridade] || CORES_PRI.media,
          deeplink: '/grow/tarefas', editavel: false,
          raw: { prioridade: t.prioridade, projeto: t.projetos?.nome || null },
        });
      }
    }
  } catch {}

  // 7. Contas do NEGÓCIO (saída pendente com vencimento) — multi-empresa.
  //    Escopo pelas empresas do grupo. `valor` vai em REAIS porque é a
  //    convenção do feed, mas a tabela guarda em centavos → /100.
  //    Tolerante: se a 091 ainda não rodou, o catch mantém o resto do feed.
  try {
    const { data: emps } = await supabase.from('empresas')
      .select('id, nome, cor').eq('grupo_id', grupoId).eq('ativa', true);
    const ids = (emps || []).map(e => e.id);
    if (ids.length) {
      const mapa = Object.fromEntries((emps || []).map(e => [e.id, e]));
      const { data } = await supabase.from('lancamentos_negocio')
        .select('id, empresa_id, descricao, valor, vencimento')
        .in('empresa_id', ids)
        .eq('tipo', 'saida').eq('status', 'pendente')
        .not('vencimento', 'is', null)
        .gte('vencimento', deStr).lte('vencimento', ateStr);
      for (const l of data || []) {
        const emp = mapa[l.empresa_id];
        eventos.push({
          id: `neg-${l.id}`, source: 'conta_negocio',
          titulo: `${emp?.nome ? `${emp.nome}: ` : ''}${l.descricao}`,
          data: l.vencimento, hora: null,
          cor: emp?.cor || '#0ea5e9',
          valor: l.valor != null ? l.valor / 100 : null,
          deeplink: '/negocios/contas', editavel: false,
        });
      }
    }
  } catch {}

  // 7b. FOLHA — salário de funcionário no dia de pagamento. Evento VIRTUAL
  //     (ocorrenciasMensais), igual dívidas: não cria linha por mês. Some do
  //     mês em que já houver pagamento lançado pra aquele funcionário.
  try {
    const { data: emps } = await supabase.from('empresas')
      .select('id, nome, cor').eq('grupo_id', grupoId).eq('ativa', true);
    const ids = (emps || []).map(e => e.id);
    if (ids.length) {
      const mapa = Object.fromEntries((emps || []).map(e => [e.id, e]));
      const { data: funcs } = await supabase.from('funcionarios_negocio')
        .select('id, empresa_id, nome, salario, dia_pagamento')
        .in('empresa_id', ids).eq('ativo', true).not('dia_pagamento', 'is', null);

      if ((funcs || []).length) {
        // Pagamentos já lançados no intervalo → não lembrar de novo.
        const { data: pagos } = await supabase.from('lancamentos_negocio')
          .select('funcionario_id, data')
          .in('funcionario_id', (funcs || []).map(f => f.id))
          .gte('data', deStr).lte('data', ateStr);
        const jaPago = new Set((pagos || []).map(p => `${p.funcionario_id}-${String(p.data).slice(0, 7)}`));

        for (const f of funcs || []) {
          const emp = mapa[f.empresa_id];
          for (const d of ocorrenciasMensais(f.dia_pagamento, deStr, ateStr)) {
            if (jaPago.has(`${f.id}-${d.slice(0, 7)}`)) continue;
            eventos.push({
              id: `folha-${f.id}-${d}`, source: 'folha',
              titulo: `Salário: ${f.nome}${emp?.nome ? ` (${emp.nome})` : ''}`,
              data: d, hora: null,
              cor: emp?.cor || '#8b5cf6',
              valor: f.salario != null ? f.salario / 100 : null,
              deeplink: '/negocios/equipe', editavel: false,
            });
          }
        }
      }
    }
  } catch {}

  // 8. Transações (gastos/receitas) — OPT-IN. Só a agenda pede isso; o briefing
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

  // Dedup — rede de segurança: eventos idênticos (mesma fonte, título, dia e
  // valor) viram um só, pra nunca duplicar no briefing/agenda mesmo com dados
  // repetidos (ex.: a mesma dívida entrando 2×).
  const vistos = new Set();
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const unicos = [];
  for (const e of eventos) {
    // ⚠️ Conta fixa ADIADA pro mesmo dia da do mês seguinte (mesmo título e
    // valor) é OUTRA conta — sem `pago`/id na chave, a de setembro ainda em
    // aberto sumia atrás da de outubro já paga. Nas outras fontes os dois
    // campos não existem e a chave fica igual à de sempre.
    const chave = `${e.source}|${norm(e.titulo)}|${e.data}|${e.valor ?? ''}|${e.hora ?? ''}|${e.pago ? 'pago' : ''}|${e.adiada ? e.id : ''}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    unicos.push(e);
  }
  return unicos;
}

module.exports = { montarFeed, isoLocal, ocorrenciasMensais };
