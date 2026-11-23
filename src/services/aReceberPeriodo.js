// =============================================================================
// "Quanto eu tenho a receber ainda este mês?" — o que ENTRA num período, com data.
//
// Relato de cliente (nov/2026): perguntou pelo WhatsApp quanto ainda tinha a
// receber no mês e a Sora respondia "nenhuma receita fixa cadastrada" — e não
// citava a 1ª parcela do 13º, prevista pra 30/11, que o painel mostrava em
// "Ainda entra". Não existia a pergunta "a receber": a frase caía na IA, que a
// mandava pra listagem de receitas fixas (que tinha o próprio defeito, corrigido
// em handlers/recorrencias.js) — e 13º não é receita FIXA, é entrada prevista.
//
// ESPELHO do "o que tenho pra pagar" (services/aPagarPeriodo.js), e usa as
// MESMAS peças: janela de datas, dia da transação e `ocorrenciasDeFixas` (a
// regra da Agenda e do "a pagar" pra dizer se a ocorrência já foi resolvida).
// Junta, por dia:
//   · RECEITA FIXA   — recorrências de Recebimento ainda não recebidas no mês;
//   · PREVISTA       — transação de Recebimento ainda NÃO recebida (pago=false)
//                      com data no período (13º, freela combinado, reembolso).
//
// ⚠️ O QUE JÁ FOI RECEBIDO NÃO APARECE — baixa ("Já recebi") ou pulada saem; a
// adiada aparece na data nova. Receita fixa LANÇADA como pendente entra uma vez
// só (pela transação). Mesmas garantias do "a pagar", pela mesma regra.
// ⚠️ Fica de fora: transferência entre contas, ajuste de saldo, "não
// considerar" e crédito na carteira de CARTÃO (estorno é da fatura, não entrada).
//
// Sem período dito, olha o RESTO DO MÊS (receita é pensada por mês — salário).
//
// A parte PURA (detectar, montar, formatar) não toca no banco e é travada em
// `eval:a-receber`. Quem busca os dados é `coletar`, logo abaixo.
// =============================================================================

const { ocorrenciasDeFixas } = require('./ocorrenciasFixas');
const { hojeSP } = require('./vencimentoDivida');
const { detectarPeriodo, janelaAPagar, diaDaTransacao, somarDias } = require('./aPagarPeriodo');

const MAX_DIAS = 92;
const DIAS_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const diaSemana = (iso) => { const [Y, M, D] = iso.split('-').map(Number); return new Date(Date.UTC(Y, M - 1, D)).getUTCDay(); };
const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ── 1. DETECTAR A PERGUNTA ──────────────────────────────────────────────────
// "o que / quanto / quais … (tenho|falta|vou|ainda…) … receber". Precisa ser
// PERGUNTA e falar em RECEBER (infinitivo): "o que eu recebo todo mês" é a
// lista de receitas fixas e segue pra ela (não casa aqui de propósito).
const RE_PERGUNTA_RECEBER = /\b(o\s*que|oq|oque|quanto|quais|qual)\b[^?!.]{0,40}?\b(tenho|tem|temos|teremos|terei|falta|faltam|ainda|vou|vamos|vai|devo|deveria)\b[^?!.]{0,25}?\breceber\b/;
// "tenho algo/dinheiro pra receber …?"
const RE_TENHO_ALGO = /\b(tenho|tem|temos)\s+(algo|alguma\s+coisa|algum\s+valor|algum\s+dinheiro|dinheiro|valores?)\s+(pra|para|a)\s+receber\b/;
// "valores a receber", "entradas pra receber", "minhas contas a receber"
const RE_COISAS_A_RECEBER = /\b(contas?|valores?|entradas?|recebimentos?)\s+(a|pra|para)\s+receber\b/;
// Relato ou lançamento, não consulta: "recebi", "já recebi".
const RE_NAO_E_PERGUNTA = /\b(recebi|recebemos|recebeu|receberam|ja\s+recebi)\b/;
// Assuntos de OUTRAS funções que falam em "receber": resumos/lembretes do zap,
// e a lista de receitas FIXAS ("o que eu tenho a receber todo mês").
const RE_OUTRO_ASSUNTO = /\b(resumos?|lembretes?|mensage(m|ns)|avisos?|notifica\w*|briefing|todo\s+mes|por\s+mes|fix[oa]s?)\b/;

/**
 * A mensagem é a pergunta "quanto tenho a receber <período>"?
 * @returns {{ acao: 'a_receber', periodo: object } | null}
 */
function detectarAReceber(mensagem) {
  const t = semAcento(mensagem).replace(/\s+/g, ' ').trim();
  if (!t || t.length > 140) return null;
  if (RE_NAO_E_PERGUNTA.test(t) || RE_OUTRO_ASSUNTO.test(t)) return null;
  const casou = RE_PERGUNTA_RECEBER.test(t) || RE_TENHO_ALGO.test(t) || RE_COISAS_A_RECEBER.test(t);
  if (!casou) return null;
  // Valor em dinheiro na frase = lançamento/lembrete, não consulta.
  const semPeriodoNum = t.replace(/\b(?:proxim[oa]s?|nos|em)\s+\d{1,2}\s+dias?\b/g, '');
  if (/\d/.test(semPeriodoNum)) return null;
  const p = detectarPeriodo(t);
  // Sem período dito: o resto do mês (e não 7 dias, como no "a pagar").
  return { acao: 'a_receber', periodo: p.padrao ? { tipo: 'mes' } : p };
}

/** Janela de datas — a mesma do "a pagar"; sem período, o resto do mês. */
function janelaAReceber(periodo, hoje = hojeSP()) {
  return janelaAPagar(periodo || { tipo: 'mes' }, hoje);
}

// ── 2. MONTAR OS ITENS ──────────────────────────────────────────────────────
const CATS_FORA = /\b(fatura|transfer[eê]ncias?|ajuste)\b/i;

/**
 * @param {object} dados
 *   recorrencias  recorrências ATIVAS de Recebimento
 *   vinculadas    [{ recorrencia_id, competencia }] — transações ligadas a uma ocorrência
 *   ajustes       [{ recorrencia_id, competencia, status, nova_data, novo_valor }]
 *   pendentes     transações de Recebimento com pago=false (já sem as de cartão)
 * @returns {Array<{ data, descricao, valor: number|null, origem: 'fixa'|'prevista', variavel?, detalhe? }>}
 */
function montarItensReceber(dados, janela) {
  const { de, ate } = janela;
  const itens = [];
  const dentro = (d) => d && d >= de && d <= ate;

  const receitasFixas = (dados.recorrencias || []).filter((r) => r.tipo === 'Recebimento' || r.tipo === 'Receita');
  const fixas = ocorrenciasDeFixas(
    { recorrencias: receitasFixas, vinculadas: dados.vinculadas, ajustes: dados.ajustes },
    { de, ate },
    { maxDias: MAX_DIAS + 31 },
  );
  for (const o of fixas) {
    if (o.estado === 'paga') continue;                  // já recebida neste mês
    // Valor corrigido no Extrato só pra ESTA ocorrência (migration 181) vence o da receita.
    const item = {
      data: o.data, descricao: o.rec.descricao || o.rec.categoria || 'Receita fixa', origem: 'fixa',
      valor: o.valorAjustado ?? o.valor, variavel: !!o.rec.valor_variavel,
    };
    if (o.adiada) item.detalhe = 'adiada';
    itens.push(item);
  }

  for (const t of dados.pendentes || []) {
    if (t.tipo !== 'Recebimento' || t.pago) continue;
    if (t.transferencia === true || t.ignorar_em || CATS_FORA.test(String(t.categoria || ''))) continue;
    const d = diaDaTransacao(t.data);
    if (!dentro(d)) continue;
    const desc = String(t.observacao || t.categoria || 'Entrada prevista')
      .replace(/^\[(Previsto|Recorrente)\]\s*/i, '')
      .replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim();
    itens.push({ data: d, descricao: desc || 'Entrada prevista', origem: 'prevista', valor: Number(t.valor) || null });
  }

  const ordem = { fixa: 0, prevista: 1 };
  return itens.sort((a, b) => a.data.localeCompare(b.data)
    || (ordem[a.origem] - ordem[b.origem]) || String(a.descricao).localeCompare(String(b.descricao)));
}

// ── 3. O TEXTO ──────────────────────────────────────────────────────────────
const ICONE = { fixa: '💰', prevista: '🗓️' };

/** @param {Function} fmt formatador da moeda base (formatadorDoGrupo) */
function formatarAReceber(itens, janela, { fmt, hoje = hojeSP() } = {}) {
  const fm = fmt || ((v) => `R$ ${Number(v).toFixed(2)}`);
  if (!itens.length) {
    return `✨ *Nada pra receber ${janela.titulo}.*\n\n`
      + '_Eu olho receitas fixas ainda não recebidas e entradas previstas (como 13º ou um valor combinado)._';
  }

  let total = 0;
  let semValor = 0;
  const porDia = new Map();
  for (const i of itens) {
    if (!porDia.has(i.data)) porDia.set(i.data, []);
    porDia.get(i.data).push(i);
    if (i.valor == null) { semValor += 1; continue; }
    total += i.valor;
  }

  const amanha = somarDias(hoje, 1);
  const blocos = [];
  for (const [d, lista] of porDia) {
    const rotulo = d === hoje ? `Hoje · ${ddmm(d)}` : d === amanha ? `Amanhã · ${ddmm(d)}` : `${DIAS_SEMANA[diaSemana(d)]} · ${ddmm(d)}`;
    const linhas = lista.map((i) => {
      const valor = i.valor == null ? 'valor a confirmar' : fm(i.valor);
      const extra = [i.origem === 'fixa' ? 'fixa' : null, i.detalhe, i.variavel && i.valor != null ? 'estimado' : null]
        .filter(Boolean).join(' · ');
      return `${ICONE[i.origem] || '•'} ${i.descricao} — *${valor}*${extra ? ` _(${extra})_` : ''}`;
    });
    blocos.push(`*${rotulo.charAt(0).toUpperCase()}${rotulo.slice(1)}*\n${linhas.join('\n')}`);
  }

  const n = itens.length;
  let rodape = `💵 *Total: ${fm(Math.round(total * 100) / 100)}* · ${n} ${n === 1 ? 'entrada' : 'entradas'}`;
  if (semValor) rodape += `\n_${semValor} sem valor definido — fora do total._`;

  return `💰 *Pra receber ${janela.titulo}*\n\n${blocos.join('\n\n')}\n\n${rodape}`;
}

// ── 4. BUSCAR NO BANCO ──────────────────────────────────────────────────────
/** Lê o que `montarItensReceber` precisa, TOLERANTE por fonte. */
async function coletar(grupoId, janela) {
  const supabase = require('../db/supabase');
  const { de, ate } = janela;
  const dados = { recorrencias: [], vinculadas: [], ajustes: [], pendentes: [] };

  const [recs, vinc, ajs, carteiras] = await Promise.all([
    supabase.from('recorrencias')
      .select('id, tipo, descricao, categoria, valor, valor_variavel, dia_vencimento, frequencia, dia_semana, mes_vencimento, data_inicio, data_fim, repeticoes, ativa')
      .eq('grupo_id', grupoId).eq('ativa', true).eq('tipo', 'Recebimento')
      .then((r) => r, () => ({ data: [] })),
    supabase.from('transacoes').select('recorrencia_id, competencia')
      .eq('grupo_id', grupoId).not('recorrencia_id', 'is', null)
      .gte('competencia', de.slice(0, 7)).lte('competencia', ate.slice(0, 7))
      .then((r) => r, () => ({ data: [] })),
    supabase.from('previsao_ajustes').select('recorrencia_id, competencia, status, nova_data, novo_valor')
      .eq('grupo_id', grupoId)
      .then((r) => r, () => ({ data: [] })),
    supabase.from('wallets').select('nome, tipo').eq('grupo_id', grupoId)
      .then((r) => r, () => ({ data: [] })),
  ]);
  dados.recorrencias = recs.data || [];
  dados.vinculadas = vinc.data || [];
  dados.ajustes = ajs.data || [];

  // Entradas previstas no período, FORA de cartão (crédito no cartão é da fatura).
  try {
    const cartoes = new Set((carteiras.data || []).filter((w) => w.tipo === 'Crédito').map((w) => String(w.nome).toLowerCase()));
    const { data } = await supabase.from('transacoes')
      .select('tipo, valor, data, observacao, categoria, carteira_nome, pago, transferencia, ignorar_em')
      .eq('grupo_id', grupoId).eq('tipo', 'Recebimento').eq('pago', false)
      .gte('data', `${somarDias(de, -1)}T00:00:00`).lte('data', `${somarDias(ate, 1)}T23:59:59`)
      .limit(300);
    dados.pendentes = (data || []).filter((t) => !cartoes.has(String(t.carteira_nome || '').toLowerCase()));
  } catch { /* segue sem */ }

  return dados;
}

module.exports = { detectarAReceber, janelaAReceber, montarItensReceber, formatarAReceber, coletar };
