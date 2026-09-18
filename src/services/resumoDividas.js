// =============================================================================
// Bloco "Dívidas" do comando RESUMO no WhatsApp (set/2026).
//
// Pedido do dono: o resumo do mês passa a mostrar também as dívidas em aberto,
// organizadas. O resumo já responde ONDE foi o dinheiro, QUANTO deu e O QUE
// VEM no mês; faltava O QUE EU DEVO.
//
// ⚠️ AS CONTAS SÃO AS MESMAS DO "minhas dívidas" (handlers/dividas.js): saldo
// = parcelas que faltam × parcela, ou `valor_total` quando não há parcelas.
// Número diferente nos dois comandos, pra mesma dívida, seria pior que não ter
// o bloco. O vencimento é o do `proximoVencimento` (respeita pagamento
// adiantado e a data do banco) — a mesma fonte do painel.
//
// ⚠️ SÓ LEITURA E SÓ TEXTO: nada aqui soma dívida no "saldo real" do resumo.
// Mexer naquele número mudaria uma conta que as pessoas já conferem todo mês.
//
// Pura (sem banco) — travada em `eval:resumo-dividas`.
// =============================================================================
const { proximoVencimento, emAtraso, hojeSP } = require('./vencimentoDivida');

const MAX_LISTADAS = 6;
const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;
const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/** Quanto falta pagar — MESMA conta do "minhas dívidas". */
function saldoDevedor(d) {
  const restantes = Math.max(0, (Number(d.parcelas_total) || 0) - (Number(d.parcelas_pagas) || 0));
  return cent(restantes * (Number(d.valor_parcela) || 0) || Number(d.valor_total) || 0);
}

/**
 * @param {Array} dividas  ativas/em atraso, com `ultimo_pagamento` preenchido
 * @param {Function} fmt   formatador da moeda do grupo
 * @returns {string} o bloco pronto, ou '' quando não há dívida (sem cabeçalho solto)
 */
function blocoDividas(dividas, fmt, hoje = hojeSP()) {
  const ativas = (dividas || []).filter((d) => ['ativa', 'em_atraso'].includes(d.status || 'ativa'));
  if (!ativas.length) return '';

  const linhas = ativas.map((d) => {
    const prox = proximoVencimento(d, hoje);
    const atrasada = d.status === 'em_atraso' || emAtraso(d, hoje);
    return { d, prox, atrasada, saldo: saldoDevedor(d) };
  });

  // Atrasadas primeiro (é o que pede ação), depois pela próxima data.
  linhas.sort((a, b) => (Number(b.atrasada) - Number(a.atrasada))
    || String(a.prox?.data || '9999').localeCompare(String(b.prox?.data || '9999')));

  const totalDevido = cent(linhas.reduce((s, l) => s + l.saldo, 0));
  const porMes = cent(linhas.reduce((s, l) => s + (Number(l.d.valor_parcela) || 0), 0));

  const itens = linhas.slice(0, MAX_LISTADAS).map(({ d, prox, atrasada, saldo }) => {
    const detalhes = [];
    if (Number(d.valor_parcela) > 0) detalhes.push(`parcela ${fmt(Number(d.valor_parcela))}`);
    if (Number(d.parcelas_total) > 0) detalhes.push(`${Number(d.parcelas_pagas) || 0}/${d.parcelas_total} pagas`);
    if (atrasada) detalhes.push('⚠️ atrasada');
    else if (prox) detalhes.push(prox.dias === 0 ? 'vence hoje' : `vence ${ddmm(prox.data)}`);
    return `• *${d.titulo || 'Dívida'}* — falta ${fmt(saldo)}`
      + (detalhes.length ? `\n   _${detalhes.join(' · ')}_` : '');
  });

  const resto = linhas.length - MAX_LISTADAS;
  const cauda = resto > 0 ? `\n_+${resto} ${resto === 1 ? 'outra' : 'outras'} · digite *minhas dívidas* pra ver todas_` : '';
  const qtdAtrasadas = linhas.filter((l) => l.atrasada).length;

  return `*📋 Dívidas em aberto (${linhas.length}):*\n${itens.join('\n')}${cauda}\n\n`
    + `💳 *Total devido: ${fmt(totalDevido)}*`
    + (porMes > 0 ? `\n_Parcelas somam ${fmt(porMes)} por mês_` : '')
    + (qtdAtrasadas ? `\n⚠️ _${qtdAtrasadas} ${qtdAtrasadas === 1 ? 'parcela atrasada' : 'dívidas com parcela atrasada'}_` : '');
}

/** Lê as dívidas do grupo (tolerante: sem elas, o resumo sai como antes). */
async function lerDividas(grupoId) {
  const supabase = require('../db/supabase');
  const { ultimoPagamentoPorDivida } = require('./vencimentoDivida');
  const COLS = 'id, titulo, valor_parcela, valor_total, parcelas_total, parcelas_pagas, dia_vencimento, status, data_inicio';
  let r = await supabase.from('dividas').select(`${COLS}, proximo_vencimento`)
    .eq('grupo_id', grupoId).in('status', ['ativa', 'em_atraso']);
  // `proximo_vencimento` é da migration 154 — sem ela, lê sem a coluna.
  if (r.error) r = await supabase.from('dividas').select(COLS).eq('grupo_id', grupoId).in('status', ['ativa', 'em_atraso']);
  const lista = r.data || [];
  if (!lista.length) return [];
  const ultimo = await ultimoPagamentoPorDivida(lista.map((d) => d.id));
  return lista.map((d) => ({ ...d, ultimo_pagamento: ultimo[d.id] || null }));
}

module.exports = { blocoDividas, lerDividas, saldoDevedor };
