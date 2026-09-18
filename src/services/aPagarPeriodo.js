// =============================================================================
// "O que eu tenho pra pagar essa semana?" — o que VENCE num período, com data.
//
// Junta, por dia, as quatro coisas que tiram dinheiro numa data conhecida:
//   · CONTA FIXA  (recorrências de Gasto) — datas pela MESMA regra do cron
//                  (`venceHoje` de frequenciaRecorrencia.js), semanais e anuais
//                  inclusive;
//   · DÍVIDA      (parcela) — pelo `proximoVencimento`, a fonte única que já
//                  respeita pagamento adiantado e a data que o banco manda;
//   · FATURA      — o `restante` da fatura atual, pela fonte única do painel;
//   · AGENDADO    — transação de gasto ainda NÃO paga com data no período
//                  (previsto único, conta variável aguardando confirmação).
//
// ⚠️ O QUE JÁ FOI RESOLVIDO NÃO APARECE. Conta fixa com baixa naquele mês
// (transação com `recorrencia_id` + `competencia`, migration 165) ou pulada
// (`previsao_ajustes`) sai da lista; adiada aparece na data NOVA. Sem isso a
// resposta mandaria pagar de novo o que a pessoa acabou de marcar como pago —
// o mesmo bug que o GastosFixosSection já teve no painel.
//
// ⚠️ CONTA FIXA LANÇADA COMO PENDENTE não aparece duas vezes: a ocorrência do
// calendário sai (tem vínculo) e entra a transação pendente, com o valor dela.
//
// ⚠️ GASTO PENDENTE NO CARTÃO FICA DE FORA — ele já está dentro da fatura, e
// listá-lo também cobraria o mesmo dinheiro duas vezes.
//
// A parte PURA (detectar, janela, montar, formatar) não toca no banco e é
// travada em `eval:a-pagar`. Quem busca os dados é `coletar`, logo abaixo.
// =============================================================================

const { venceHoje } = require('./frequenciaRecorrencia');
const { proximoVencimento, ocorrencia, hojeSP, emAtraso } = require('./vencimentoDivida');

const DIA_MS = 864e5;
const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const MAX_DIAS = 92;

// ── datas em 'YYYY-MM-DD' (sem fuso pra errar) ──────────────────────────────
function somarDias(iso, n) {
  const [Y, M, D] = iso.split('-').map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D) + n * DIA_MS);
  return d.toISOString().slice(0, 10);
}
function diaSemana(iso) {
  const [Y, M, D] = iso.split('-').map(Number);
  return new Date(Date.UTC(Y, M - 1, D)).getUTCDay();
}
function ultimoDiaMes(iso) {
  const [Y, M] = iso.split('-').map(Number);
  return new Date(Date.UTC(Y, M, 0)).toISOString().slice(0, 10);
}
const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/**
 * Dia (SP) de um valor de `transacoes.data` (timestamptz).
 * Meia-noite UTC em ponto = data PURA (o backend grava 'YYYY-MM-DD'); qualquer
 * outro horário é instante real → converte pra SP. Mesma regra de lib/data-br.
 */
function diaDaTransacao(v) {
  const s = String(v || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?(Z|\+00(:?00)?)$/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

// ── 1. DETECTAR A PERGUNTA ──────────────────────────────────────────────────
const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// "o que / quanto / quais … (tenho|tem|falta|preciso|devo) … [pra|que|…] pagar".
// A preposição é opcional: "o que falta pagar", "quanto preciso pagar".
const RE_PERGUNTA_PAGAR = /\b(o\s*que|oq|oque|quanto|quais|qual)\b[^?!.]{0,40}?\b(tenho|tem|temos|teremos|terei|preciso|precisamos|falta|faltam|devo|devemos|vou\s+ter|vamos\s+ter)\b[^?!.]{0,25}?\bpagar\b/;
// "tenho algo/alguma conta pra pagar …?"
const RE_TENHO_ALGO = /\b(tenho|tem|temos)\s+(algo|alguma\s+coisa|alguma\s+conta|algum\s+boleto|conta|contas|boleto|boletos)\s+(pra|para|a)\s+pagar\b/;
// "contas a pagar", "boletos pra pagar", "minhas contas a pagar"
const RE_CONTAS_A_PAGAR = /\b(contas?|boletos?)\s+(a|pra|para|que\s+tenho\s+(pra|para|a))\s+pagar\b/;
// "o que vence hoje", "quais contas vencem essa semana" — SÓ com período dito:
// "qual dia vence a fatura?" é pergunta sobre o cartão, não sobre a agenda.
const RE_VENCE = /\b(o\s*que|oq|oque|quais|qual|que\s+contas?|quanto)\b[^?!.]{0,30}?\bvence(m)?\b/;

// Pergunta, não relato nem lançamento: "paguei", "pagar a luz 120" e afins.
const RE_NAO_E_PERGUNTA = /\b(paguei|pagamos|pagou|ja\s+paguei)\b/;

/**
 * Período dito na frase. Sem período → próximos 7 dias.
 * @returns {{ tipo: string, n?: number }}
 */
function detectarPeriodo(t) {
  let m;
  if (/\bdepois\s+de\s+amanh?a\b/.test(t)) return { tipo: 'depois_amanha' };
  if (/\bamanh?a\b/.test(t)) return { tipo: 'amanha' };
  if (/\b(hoje|hj)\b/.test(t)) return { tipo: 'hoje' };
  if ((m = t.match(/\bproxim[oa]s?\s+(\d{1,2})\s+dias?\b/)) || (m = t.match(/\b(?:nos|em)\s+(\d{1,2})\s+dias\b/))) {
    return { tipo: 'dias', n: Math.max(1, Math.min(MAX_DIAS, Number(m[1]))) };
  }
  if (/\bproxim[oa]s\s+dias\b/.test(t)) return { tipo: 'dias', n: 7 };
  if (/\b(semana\s+que\s+vem|proxima\s+semana|semana\s+seguinte)\b/.test(t)) return { tipo: 'proxima_semana' };
  if (/\bsemana\b/.test(t)) return { tipo: 'semana' };
  if (/\b(mes\s+que\s+vem|proximo\s+mes|mes\s+seguinte)\b/.test(t)) return { tipo: 'proximo_mes' };
  if (/\bmes\b/.test(t)) return { tipo: 'mes' };
  return { tipo: 'dias', n: 7, padrao: true };
}

const TEM_PERIODO = /\b(hoje|hj|amanh?a|semana|mes|proxim[oa]s?\s+\d{1,2}\s+dias?|proxim[oa]s\s+dias|nos\s+\d{1,2}\s+dias)\b/;

/**
 * A mensagem é a pergunta "o que tenho pra pagar <período>"?
 * @returns {{ acao: 'a_pagar', periodo: object } | null}
 */
function detectarAPagar(mensagem) {
  const t = semAcento(mensagem).replace(/\s+/g, ' ').trim();
  if (!t || t.length > 140) return null;
  if (RE_NAO_E_PERGUNTA.test(t)) return null;
  const casou = RE_PERGUNTA_PAGAR.test(t) || RE_TENHO_ALGO.test(t) || RE_CONTAS_A_PAGAR.test(t)
    || (RE_VENCE.test(t) && TEM_PERIODO.test(t) && !/\b(fatura|cartao)\b/.test(t));
  if (!casou) return null;
  // Valor em dinheiro na frase = lançamento/pagamento, não consulta.
  // ("próximos 15 dias" tem número, mas é o período — já tirado antes do teste.)
  const semPeriodoNum = t.replace(/\b(?:proxim[oa]s?|nos|em)\s+\d{1,2}\s+dias?\b/g, '');
  if (/\d/.test(semPeriodoNum)) return null;
  return { acao: 'a_pagar', periodo: detectarPeriodo(t) };
}

// ── 2. A JANELA DE DATAS ────────────────────────────────────────────────────
/**
 * @returns {{ de: string, ate: string, titulo: string }}  datas inclusivas.
 * Tudo começa HOJE: "essa semana" numa quinta é quinta→domingo — o que já
 * passou ou foi pago ou está atrasado, e a pergunta é sobre o que vem.
 */
function janelaAPagar(periodo, hoje = hojeSP()) {
  // A IA às vezes devolve o período como texto ("semana") em vez do objeto.
  const p = typeof periodo === 'string' ? { tipo: periodo } : (periodo || { tipo: 'dias', n: 7 });
  switch (p.tipo) {
    case 'hoje':          return { de: hoje, ate: hoje, titulo: `hoje (${ddmm(hoje)})` };
    case 'amanha': {
      const d = somarDias(hoje, 1);
      return { de: d, ate: d, titulo: `amanhã (${ddmm(d)})` };
    }
    case 'depois_amanha': {
      const d = somarDias(hoje, 2);
      return { de: d, ate: d, titulo: `depois de amanhã (${ddmm(d)})` };
    }
    case 'semana': {
      const dow = diaSemana(hoje);                     // 0 = domingo
      const ate = somarDias(hoje, dow === 0 ? 0 : 7 - dow);
      return { de: hoje, ate, titulo: `esta semana (${ddmm(hoje)} a ${ddmm(ate)})` };
    }
    case 'proxima_semana': {
      const dow = diaSemana(hoje);
      const seg = somarDias(hoje, dow === 0 ? 1 : 8 - dow);
      const dom = somarDias(seg, 6);
      return { de: seg, ate: dom, titulo: `a semana que vem (${ddmm(seg)} a ${ddmm(dom)})` };
    }
    case 'mes': {
      const ate = ultimoDiaMes(hoje);
      return { de: hoje, ate, titulo: `este mês (${ddmm(hoje)} a ${ddmm(ate)})` };
    }
    case 'proximo_mes': {
      const de = somarDias(ultimoDiaMes(hoje), 1);
      const ate = ultimoDiaMes(de);
      return { de, ate, titulo: `o mês que vem (${ddmm(de)} a ${ddmm(ate)})` };
    }
    default: {
      const n = Math.max(1, Math.min(MAX_DIAS, Number(p.n) || 7));
      const ate = somarDias(hoje, n);
      return { de: hoje, ate, titulo: `os próximos ${n} dias (${ddmm(hoje)} a ${ddmm(ate)})` };
    }
  }
}

// ── 3. MONTAR OS ITENS ──────────────────────────────────────────────────────
function diasEntre(de, ate) {
  const out = [];
  for (let d = de; d <= ate && out.length <= MAX_DIAS + 31; d = somarDias(d, 1)) out.push(d);
  return out;
}

const CATS_FORA = /\b(fatura|transfer[eê]ncias?|ajuste)\b/i;

/**
 * @param {object} dados
 *   recorrencias  recorrências ATIVAS de Gasto
 *   vinculadas    [{ recorrencia_id, competencia }] — transações ligadas a uma ocorrência
 *   ajustes       [{ recorrencia_id, competencia, status, nova_data, novo_valor }]
 *   pendentes     transações de Gasto com pago=false (já sem as de cartão)
 *   dividas       dívidas ativas, com `ultimo_pagamento` já preenchido
 *   faturas       [{ nome, venc, restante, moeda }] — só a fatura ATUAL de cada cartão
 * @returns {Array<{ data, descricao, valor: number|null, origem, moeda?, detalhe? }>}
 */
function montarItens(dados, janela, hoje = hojeSP()) {
  const { de, ate } = janela;
  const itens = [];
  const dentro = (d) => d && d >= de && d <= ate;

  // Conta fixa: ocorrência do calendário, menos o que já foi resolvido.
  const vinc = new Set((dados.vinculadas || []).map((v) => `${v.recorrencia_id}|${v.competencia}`));
  const ajuste = new Map((dados.ajustes || []).map((a) => [`${a.recorrencia_id}|${a.competencia}`, a]));
  const dias = diasEntre(de, ate);
  for (const r of dados.recorrencias || []) {
    if (r.tipo && r.tipo !== 'Gasto') continue;
    const semanal = (r.frequencia || 'mensal') === 'semanal';
    // Adiada PRA DENTRO da janela (vinda de uma competência cuja data
    // original está fora dela) também tem de aparecer.
    const jaListadas = new Set();
    for (const d of dias) {
      if (!venceHoje(r, d)) continue;
      const comp = d.slice(0, 7);
      // ⚠️ Semanal tem várias ocorrências no mês e a chave é mensal: uma baixa
      // esconderia as outras semanas. Nelas, só o calendário vale.
      if (!semanal) {
        if (vinc.has(`${r.id}|${comp}`)) continue;
        const aj = ajuste.get(`${r.id}|${comp}`);
        if (aj?.status === 'pulado') continue;
        if (aj?.status === 'movido') continue;      // tratada no laço de ajustes abaixo
      }
      jaListadas.add(comp);
      itens.push({
        data: d, descricao: r.descricao || 'Conta fixa', origem: 'fixa',
        valor: Number(r.valor) > 0 ? Number(r.valor) : null,
        variavel: !!r.valor_variavel,
      });
    }
  }
  // Ocorrências ADIADAS: aparecem na data nova (se ela cair na janela e a
  // ocorrência ainda não tiver baixa).
  const recPorId = new Map((dados.recorrencias || []).map((r) => [r.id, r]));
  for (const a of dados.ajustes || []) {
    if (a.status !== 'movido' || !dentro(String(a.nova_data || '').slice(0, 10))) continue;
    const r = recPorId.get(a.recorrencia_id);
    if (!r || (r.tipo && r.tipo !== 'Gasto')) continue;
    if (vinc.has(`${r.id}|${a.competencia}`)) continue;
    const v = Number(a.novo_valor) > 0 ? Number(a.novo_valor) : Number(r.valor);
    itens.push({
      data: String(a.nova_data).slice(0, 10), descricao: r.descricao || 'Conta fixa', origem: 'fixa',
      valor: v > 0 ? v : null, variavel: !!r.valor_variavel, detalhe: 'adiada',
    });
  }

  // Gastos agendados / previstos ainda não pagos.
  for (const t of dados.pendentes || []) {
    if (t.tipo !== 'Gasto' || t.pago) continue;
    if (t.transferencia === true || t.ignorar_em || CATS_FORA.test(String(t.categoria || ''))) continue;
    const d = diaDaTransacao(t.data);
    if (!dentro(d)) continue;
    const desc = String(t.observacao || t.categoria || 'Gasto previsto')
      .replace(/^\[(Previsto|Recorrente)\]\s*/i, '')
      .replace(/\p{Extended_Pictographic}/gu, '').trim();
    itens.push({ data: d, descricao: desc || 'Gasto previsto', origem: 'agendado', valor: Number(t.valor) || null });
  }

  // Dívidas: próxima parcela e, em janela longa, as seguintes.
  for (const dv of dados.dividas || []) {
    if (!['ativa', 'em_atraso'].includes(dv.status || 'ativa')) continue;
    const total = Number(dv.parcelas_total) || 0;
    const pagas = Number(dv.parcelas_pagas) || 0;
    let restantes = total > 0 ? total - pagas : Infinity;
    if (restantes <= 0) continue;
    const prox = proximoVencimento(dv, hoje);
    if (!prox) continue;
    let d = prox.data;
    let k = 0;
    const [Y, M] = d.split('-').map(Number);
    while (d <= ate && restantes > 0) {
      if (d >= de) {
        const n = total > 0 ? pagas + 1 + k : null;
        itens.push({
          data: d, descricao: dv.titulo || 'Dívida', origem: 'divida',
          valor: Number(dv.valor_parcela) > 0 ? Number(dv.valor_parcela) : null,
          detalhe: n ? `parcela ${n}/${total}` : null,
        });
      }
      k += 1; restantes -= 1;
      d = ocorrencia(Y, M - 1 + k, Number(dv.dia_vencimento) || Number(d.slice(8, 10)));
    }
  }

  // Faturas: o vencimento da fatura ATUAL, se cair na janela e tiver saldo.
  for (const f of dados.faturas || []) {
    if (!dentro(f.venc)) continue;
    if (f.restante != null && f.restante <= 0.009) continue;     // já quitada
    itens.push({
      data: f.venc, descricao: `Fatura ${f.nome}`, origem: 'fatura',
      valor: f.restante == null ? null : Number(f.restante), moeda: f.moeda || null,
    });
  }

  const ordem = { fatura: 0, divida: 1, fixa: 2, agendado: 3 };
  return itens.sort((a, b) => a.data.localeCompare(b.data)
    || (ordem[a.origem] - ordem[b.origem]) || String(a.descricao).localeCompare(String(b.descricao)));
}

// ── 4. O TEXTO ──────────────────────────────────────────────────────────────
const ICONE = { fatura: '💳', divida: '📋', fixa: '📌', agendado: '🗓️' };

/**
 * @param {Function} fmt        formatador da moeda base (formatadorDoGrupo)
 * @param {Function} fmtMoeda   (valor, moeda) → texto, pra fatura de cartão em outra moeda
 * @param {Function} paraBase   (valor, moeda) → número na base ou null (sem câmbio)
 */
function formatarAPagar(itens, janela, { fmt, fmtMoeda, paraBase, hoje = hojeSP(), atrasadas = 0 } = {}) {
  const fm = fmt || ((v) => `R$ ${Number(v).toFixed(2)}`);
  // A janela começa hoje, então parcela que JÁ venceu sem pagamento não entra
  // na lista — mas esconder dívida atrasada seria pior. Vira um aviso.
  const avisoAtraso = atrasadas > 0
    ? `\n\n⚠️ _${atrasadas === 1 ? '1 dívida está' : `${atrasadas} dívidas estão`} com parcela atrasada — digite *minhas dívidas*._`
    : '';
  if (!itens.length) {
    return `✨ *Nada pra pagar ${janela.titulo}.*\n\n`
      + '_Eu olho contas fixas, parcelas de dívidas, faturas de cartão e gastos agendados._' + avisoAtraso;
  }

  let total = 0;
  let semValor = 0;
  let semCambio = 0;
  const porDia = new Map();
  for (const i of itens) {
    if (!porDia.has(i.data)) porDia.set(i.data, []);
    porDia.get(i.data).push(i);
    if (i.valor == null) { semValor += 1; continue; }
    const naBase = i.moeda && paraBase ? paraBase(i.valor, i.moeda) : i.valor;
    if (naBase == null) { semCambio += 1; continue; }
    total += naBase;
  }

  const amanha = somarDias(hoje, 1);
  const blocos = [];
  for (const [d, lista] of porDia) {
    const rotulo = d === hoje ? `Hoje · ${ddmm(d)}` : d === amanha ? `Amanhã · ${ddmm(d)}` : `${DIAS_SEMANA[diaSemana(d)]} · ${ddmm(d)}`;
    const linhas = lista.map((i) => {
      const valor = i.valor == null
        ? (i.origem === 'fatura' ? 'valor em aberto' : 'valor a confirmar')
        : (i.moeda && fmtMoeda ? fmtMoeda(i.valor, i.moeda) : fm(i.valor));
      const extra = [i.detalhe, i.variavel && i.valor != null ? 'estimado' : null].filter(Boolean).join(' · ');
      return `${ICONE[i.origem] || '•'} ${i.descricao} — *${valor}*${extra ? ` _(${extra})_` : ''}`;
    });
    blocos.push(`*${rotulo.charAt(0).toUpperCase()}${rotulo.slice(1)}*\n${linhas.join('\n')}`);
  }

  const n = itens.length;
  let rodape = `💰 *Total: ${fm(Math.round(total * 100) / 100)}* · ${n} ${n === 1 ? 'conta' : 'contas'}`;
  if (semValor) rodape += `\n_${semValor} sem valor definido — fora do total._`;
  if (semCambio) rodape += `\n_${semCambio} em outra moeda sem câmbio — fora do total._`;

  return `🗓️ *Pra pagar ${janela.titulo}*\n\n${blocos.join('\n\n')}\n\n${rodape}${avisoAtraso}`;
}

// ── 5. BUSCAR NO BANCO ──────────────────────────────────────────────────────
/**
 * Lê tudo que `montarItens` precisa, TOLERANTE por fonte: se uma falhar, as
 * outras seguem (uma resposta sem as faturas é melhor que nenhuma resposta).
 */
async function coletar(grupoId, janela) {
  const supabase = require('../db/supabase');
  const { de, ate } = janela;
  const compDe = de.slice(0, 7);
  const compAte = ate.slice(0, 7);
  const dados = { recorrencias: [], vinculadas: [], ajustes: [], pendentes: [], dividas: [], faturas: [] };

  const [recs, vinc, ajs, carteiras] = await Promise.all([
    supabase.from('recorrencias')
      .select('id, tipo, descricao, valor, valor_variavel, dia_vencimento, frequencia, dia_semana, mes_vencimento, data_inicio, data_fim, repeticoes, ativa')
      .eq('grupo_id', grupoId).eq('ativa', true).eq('tipo', 'Gasto')
      .then((r) => r, () => ({ data: [] })),
    supabase.from('transacoes').select('recorrencia_id, competencia')
      .eq('grupo_id', grupoId).not('recorrencia_id', 'is', null)
      .gte('competencia', compDe).lte('competencia', compAte)
      .then((r) => r, () => ({ data: [] })),
    supabase.from('previsao_ajustes').select('recorrencia_id, competencia, status, nova_data, novo_valor')
      .eq('grupo_id', grupoId)
      .then((r) => r, () => ({ data: [] })),
    supabase.from('wallets').select('id, nome, tipo, saldo, of_conta_id, dia_fechamento, dia_vencimento, moeda, datas_manuais')
      .eq('grupo_id', grupoId)
      .then((r) => r, () => ({ data: [] })),
  ]);
  dados.recorrencias = recs.data || [];
  dados.vinculadas = vinc.data || [];
  dados.ajustes = ajs.data || [];
  const wallets = carteiras.data || [];

  // Gastos pendentes no período, FORA de cartão (esses estão na fatura).
  try {
    const cartoes = new Set(wallets.filter((w) => w.tipo === 'Crédito').map((w) => String(w.nome).toLowerCase()));
    const { data } = await supabase.from('transacoes')
      .select('tipo, valor, data, observacao, categoria, carteira_nome, pago, transferencia, ignorar_em')
      .eq('grupo_id', grupoId).eq('tipo', 'Gasto').eq('pago', false)
      .gte('data', `${somarDias(de, -1)}T00:00:00`).lte('data', `${somarDias(ate, 1)}T23:59:59`)
      .limit(300);
    dados.pendentes = (data || []).filter((t) => !cartoes.has(String(t.carteira_nome || '').toLowerCase()));
  } catch { /* segue sem */ }

  // Dívidas + data do último pagamento (é o que o proximoVencimento precisa).
  try {
    const { data } = await supabase.from('dividas')
      .select('id, titulo, valor_parcela, parcelas_total, parcelas_pagas, dia_vencimento, status, data_inicio, proximo_vencimento')
      .eq('grupo_id', grupoId).in('status', ['ativa', 'em_atraso']);
    const { ultimoPagamentoPorDivida } = require('./vencimentoDivida');
    const ultimo = await ultimoPagamentoPorDivida((data || []).map((d) => d.id));
    dados.dividas = (data || []).map((d) => ({ ...d, ultimo_pagamento: ultimo[d.id] || null }));
  } catch {
    // `proximo_vencimento` (migration 154) pode não existir: tenta sem ele.
    try {
      const { data } = await supabase.from('dividas')
        .select('id, titulo, valor_parcela, parcelas_total, parcelas_pagas, dia_vencimento, status, data_inicio')
        .eq('grupo_id', grupoId).in('status', ['ativa', 'em_atraso']);
      const { ultimoPagamentoPorDivida } = require('./vencimentoDivida');
      const ultimo = await ultimoPagamentoPorDivida((data || []).map((d) => d.id));
      dados.dividas = (data || []).map((d) => ({ ...d, ultimo_pagamento: ultimo[d.id] || null }));
    } catch { /* segue sem */ }
  }

  // Faturas: a fatura atual de cada cartão, pela fonte única do painel.
  const cartoes = wallets.filter((w) => w.tipo === 'Crédito' && w.dia_vencimento);
  if (cartoes.length) {
    const { competenciaAtual, cicloPorCompetencia } = require('./cicloFatura');
    const { statusFatura } = require('./faturaRollover');
    const { valorExibido } = require('./faturaVista');
    const { lerPrevistas } = require('./parcelasPrevistas');
    for (const c of cartoes) {
      try {
        const comp = competenciaAtual(c);
        const venc = cicloPorCompetencia(c, comp).venc;
        if (!venc || venc < de || venc > ate) continue;   // nem calcula o que não vai usar
        const st = await statusFatura(grupoId, c, comp);
        const vista = await valorExibido(c, comp, st, { parcelasPrevistas: lerPrevistas });
        if (vista.quitada) continue;
        dados.faturas.push({ nome: c.nome, venc, restante: vista.restante ?? null, moeda: c.moeda || null });
      } catch { /* cartão sem ciclo calculável: fica de fora */ }
    }
  }

  return dados;
}

/** Quantas dívidas têm parcela vencida e sem pagamento (regra do painel). */
function contarAtrasadas(dividas, hoje = hojeSP()) {
  return (dividas || []).filter((d) => d.status === 'em_atraso' || emAtraso(d, hoje)).length;
}

module.exports = {
  contarAtrasadas,
  detectarAPagar, detectarPeriodo, janelaAPagar, montarItens, formatarAPagar, coletar,
  diaDaTransacao, somarDias,
};
