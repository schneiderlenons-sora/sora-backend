// =============================================================================
// CONTAS QUE SE REPETEM no Sora Negócios (migration 192).
//
// Pedido (Robert, out/2026): ele trabalha com um contrato recebido TODA SEMANA
// e contas a pagar projetadas. O campo `recorrencia` existia desde a 091, mas
// nada gerava as próximas — cada semana tinha de ser cadastrada à mão.
//
// Como funciona:
//   · cada ocorrência é um lançamento EM ABERTO comum (a receber / a pagar),
//     com o mesmo `serie_id`. Nada de tabela paralela: baixa, DRE, agenda e o
//     espelho do banco já sabem lidar com conta em aberto.
//   · o servidor gera as próximas até um HORIZONTE (não "pra sempre"): é a
//     projeção que a pessoa usa, e o job diário mantém o horizonte andando.
//   · a baixa automática do espelho do banco (mesmo valor, até 6 dias do
//     vencimento, a mais antiga primeiro) fecha o ciclo sozinha.
//
// ⚠️ GERA SÓ DEPOIS DA ÚLTIMA OCORRÊNCIA EXISTENTE, nunca "as que faltam no
// meio". Quem apagou a semana do feriado não quer que ela volte amanhã.
// ⚠️ O DIA DO MÊS É O DA PRIMEIRA OCORRÊNCIA. Mensal que vence dia 31 vence
// 30/04 e 28/02, e volta a 31 em maio — ancorar na anterior (30) faria a série
// derivar pra 28 pra sempre depois de fevereiro.
// =============================================================================

const RECORRENCIAS = ['semanal', 'mensal', 'anual'];

/** Até quantos dias à frente a série fica gerada. */
const HORIZONTE_DIAS = { semanal: 91, mensal: 186, anual: 400 };

/** Quanto pra TRÁS a geração alcança. Cobre dias em que o job não rodou, mas
 *  série esquecida há meses não vira uma enxurrada de "atrasadas" de mentira. */
const DIAS_PASSADO = 31;

/** Trava contra laço: nenhuma série gera mais que isso de uma vez. */
const MAX_POR_PASSADA = 60;

const dia = (v) => String(v || '').slice(0, 10);
const somaDias = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const ultimoDia = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** A n-ésima ocorrência a partir da âncora (n = 0 é a própria âncora). */
function ocorrencia(ancora, recorrencia, n) {
  if (recorrencia === 'semanal') return somaDias(ancora, 7 * n);
  const [Y, M, D] = ancora.split('-').map(Number);
  const meses = recorrencia === 'anual' ? 12 * n : n;
  const base = new Date(Date.UTC(Y, M - 1 + meses, 1));
  const y = base.getUTCFullYear(); const m = base.getUTCMonth();
  const d = Math.min(D, ultimoDia(y, m));
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Data que ancora a ocorrência: o vencimento; sem ele (já paga), a data. */
const quando = (l) => dia(l.vencimento || l.data);

/** Campos que a próxima ocorrência herda do modelo (a ocorrência mais recente). */
const HERDADOS = [
  'empresa_id', 'user_id', 'tipo', 'categoria', 'descricao', 'valor', 'contraparte',
  'conta_id', 'centro_custo_id', 'forma_pagamento', 'observacao',
];

/**
 * O que falta gerar numa série (puro).
 *
 * @param {object[]} linhas  as ocorrências existentes da série (qualquer situação)
 * @param {string}   hoje    'YYYY-MM-DD' em São Paulo
 * @returns {object[]} as ocorrências a inserir
 */
function planejarSerie(linhas, hoje) {
  const validas = (linhas || []).filter((l) => l && l.serie_id && quando(l));
  if (!validas.length) return [];
  const ord = [...validas].sort((a, b) => quando(a).localeCompare(quando(b)));
  const primeira = ord[0];
  const modelo = ord[ord.length - 1];
  const rec = modelo.recorrencia;
  // Série parada ("parar de repetir") ou sem recorrência válida: nada a fazer.
  if (modelo.recorrente === false || !RECORRENCIAS.includes(rec)) return [];

  const ultima = quando(modelo);
  const limite = [somaDias(hoje, HORIZONTE_DIAS[rec]), modelo.serie_ate ? dia(modelo.serie_ate) : null]
    .filter(Boolean).sort()[0];

  const piso = somaDias(hoje, -DIAS_PASSADO);
  const ancora = quando(primeira);
  const out = [];
  for (let n = 1; out.length < MAX_POR_PASSADA && n < 2000; n++) {
    const d = ocorrencia(ancora, rec, n);
    if (d > limite) break;
    if (d <= ultima || d < piso) continue;
    const nova = {};
    for (const k of HERDADOS) if (modelo[k] !== undefined) nova[k] = modelo[k];
    Object.assign(nova, {
      status: 'pendente', vencimento: d, data: d, pago_em: null,
      recorrente: true, recorrencia: rec, serie_id: modelo.serie_id, serie_ate: modelo.serie_ate || null,
    });
    out.push(nova);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXECUÇÃO
// ─────────────────────────────────────────────────────────────────────────────

const hojeSP = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

/** Gera o que falta de UMA série. @returns {Promise<number>} quantas criou */
async function gerarSerie(serieId, { supabase = require('../db/supabase'), hoje = hojeSP() } = {}) {
  if (!serieId) return 0;
  const { data, error } = await supabase.from('lancamentos_negocio').select('*').eq('serie_id', serieId);
  if (error) throw error;
  const novas = planejarSerie(data || [], hoje);
  if (!novas.length) return 0;
  const { error: e2 } = await supabase.from('lancamentos_negocio').insert(novas);
  if (e2) throw e2;
  return novas.length;
}

/**
 * Job diário: mantém o horizonte de toda série ativa andando.
 * ⚠️ Tolerante: sem a migration 192 a consulta falha e o job não faz nada.
 */
async function estenderSeries({ supabase = require('../db/supabase'), hoje = hojeSP() } = {}) {
  const linhas = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await supabase.from('lancamentos_negocio')
      .select('*').not('serie_id', 'is', null).order('id').range(de, de + 999);
    if (error) return { series: 0, criadas: 0, erro: error.message };
    linhas.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const porSerie = new Map();
  for (const l of linhas) {
    if (!porSerie.has(l.serie_id)) porSerie.set(l.serie_id, []);
    porSerie.get(l.serie_id).push(l);
  }
  let criadas = 0;
  for (const [, ls] of porSerie) {
    const novas = planejarSerie(ls, hoje);
    if (!novas.length) continue;
    const { error } = await supabase.from('lancamentos_negocio').insert(novas);
    if (error) { console.warn('[séries negócio]', error.message); continue; }
    criadas += novas.length;
  }
  return { series: porSerie.size, criadas };
}

module.exports = { RECORRENCIAS, HORIZONTE_DIAS, ocorrencia, planejarSerie, gerarSerie, estenderSeries, quando };
