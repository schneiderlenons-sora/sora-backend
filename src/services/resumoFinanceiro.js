// =====================================================================
// Resumos financeiros proativos (semanal + fechamento mensal).
// Usado pelos crons em jobs/index.js. Calcula a partir de `transacoes`
// (tipo === 'Gasto' = despesa, senão receita), escopado por grupo.
// =====================================================================
const supabase = require('../db/supabase');

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://forsora.com';
const brl = (v) => `R$ ${Number(v || 0).toFixed(2)}`;
const limpaCat = (s) => (s || '').replace(/\p{Emoji}/gu, '').trim() || 'Outros';

/**
 * Soma gastos/receitas/categorias de um grupo no intervalo [inicio, fim).
 * Datas no formato YYYY-MM-DD.
 */
async function resumoPeriodo(grupoId, inicio, fim) {
  const { data: rows } = await supabase
    .from('transacoes').select('tipo, categoria, valor')
    .eq('grupo_id', grupoId)
    .gte('data', inicio).lt('data', fim);

  let gastos = 0, receitas = 0, count = 0;
  const cats = {};
  for (const r of rows || []) {
    count++;
    if (r.tipo === 'Gasto') {
      gastos += r.valor || 0;
      const nome = limpaCat(r.categoria);
      cats[nome] = (cats[nome] || 0) + (r.valor || 0);
    } else {
      receitas += r.valor || 0;
    }
  }
  const topCats = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  return { gastos, receitas, saldo: receitas - gastos, count, topCats };
}

// Variação % dos gastos vs período anterior. Menos gasto = ↓ (bom).
function deltaGastos(atual, anterior, label) {
  if (!anterior || anterior <= 0) return '';
  const pct = Math.round(((atual - anterior) / anterior) * 100);
  if (pct === 0) return ` (igual ${label})`;
  return ` (${pct < 0 ? '↓' : '↑'}${Math.abs(pct)}% ${label})`;
}

function montarResumoSemanal({ atual, anterior }) {
  const partes = [
    '📅 *Resumo da sua semana*',
    'Últimos 7 dias:',
    '',
    `🔴 Gastos: ${brl(atual.gastos)}${deltaGastos(atual.gastos, anterior.gastos, 'vs semana passada')}`,
    `🟢 Receitas: ${brl(atual.receitas)}`,
    `💰 *Saldo: ${brl(atual.saldo)}*`,
  ];
  if (atual.topCats.length) {
    const [nome, val] = atual.topCats[0];
    partes.push('', `Maior categoria: *${nome}* (${brl(val)})`);
  }
  partes.push('', `🌐 ${APP_URL}/dashboard`, '_Pra parar: *desativar resumos*_');
  return partes.join('\n');
}

function montarResumoMensal({ mesNome, atual, anterior, metaMensal }) {
  const partes = [
    `🧾 *Fechamento de ${mesNome}*`,
    '',
    `🔴 Gastos: ${brl(atual.gastos)}${deltaGastos(atual.gastos, anterior.gastos, 'vs mês anterior')}`,
    `🟢 Receitas: ${brl(atual.receitas)}`,
    `💰 *Saldo: ${brl(atual.saldo)}*`,
  ];
  if (atual.topCats.length) {
    partes.push('', '*Top categorias:*');
    atual.topCats.slice(0, 3).forEach(([nome, val]) => partes.push(`• ${nome}: ${brl(val)}`));
  }
  if (metaMensal > 0) {
    const pct = Math.round((atual.gastos / metaMensal) * 100);
    partes.push('', `🎯 Meta do mês: ${brl(metaMensal)} (${pct}% usado)`);
  }
  partes.push('', `Veja o mês completo: ${APP_URL}/dashboard`, '_Pra parar: *desativar resumos*_');
  return partes.join('\n');
}

module.exports = { resumoPeriodo, montarResumoSemanal, montarResumoMensal };
