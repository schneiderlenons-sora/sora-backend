// =============================================================================
// Faturas PUBLICADAS pelo banco (Open Finance) — persistência e leitura.
//
// O emissor manda, por fatura: `due_date`, `bill_closing_date`,
// `bill_total_amount` e `payments[]`. Esse é o número que o cliente vê no app
// do banco. Até aqui a Sora recebia isso a cada sync e descartava, guardando
// só o ID da fatura aberta e RECONSTRUINDO o valor pela soma das transações
// importadas — frágil por natureza (ver o cabeçalho de sql/118).
//
// Aqui a fatura vira registro. O valor exibido passa a sair do banco; a soma
// das transações fica só pro ciclo que o emissor ainda NÃO publicou.
//
// ⚠️ TUDO É TOLERANTE À MIGRATION 118: enquanto ela não roda, gravar e ler
// devolvem vazio e o sistema inteiro cai no comportamento anterior. Nenhuma
// função daqui pode derrubar o sync.
// =============================================================================
const { competenciaVizinha } = require('./cicloFatura');

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;
const ymd = (d) => (d ? String(d).slice(0, 10) : null);

/** `{ amount, currency }` (ou número/string cru) → número. */
function money(v) {
  if (v == null) return null;
  const n = Number(typeof v === 'object' ? v.amount : v);
  return Number.isFinite(n) ? n : null;
}

/** Soma de `payments[]` da fatura. */
function pagoDaBill(bill) {
  const arr = bill && Array.isArray(bill.payments) ? bill.payments : [];
  return cent(arr.reduce((s, p) => s + Math.abs(money(p && p.amount !== undefined ? p.amount : p) || 0), 0));
}

/**
 * Achata uma fatura crua da Polp. `null` quando não dá pra usar.
 *
 * Sem `due_date` não há competência — e competência é a chave de tudo por
 * aqui (pagamentos_fatura, rollover, ciclo). Fatura sem vencimento é
 * inutilizável, não "meio utilizável".
 */
function normalizarBill(bill) {
  if (!bill || !bill.id || !bill.due_date) return null;
  const venc = ymd(bill.due_date);
  const total = money(bill.bill_total_amount);
  return {
    of_bill_id:   String(bill.id),
    competencia:  venc.slice(0, 7),          // 'YYYY-MM' do VENCIMENTO
    vencimento:   venc,
    fechamento:   ymd(bill.bill_closing_date),
    total:        total == null ? null : cent(Math.abs(total)),
    pago:         pagoDaBill(bill),
    minimo:       money(bill.bill_minimum_amount) == null ? null : cent(Math.abs(money(bill.bill_minimum_amount))),
    is_parcelada: bill.is_instalment === true,
  };
}

/**
 * Grava/atualiza no banco todas as faturas publicadas do cartão.
 *
 * @returns {Promise<number>} quantas faturas ficaram registradas
 */
async function salvarFaturas(grupoId, cartaoId, bills) {
  try {
    if (!grupoId || !cartaoId) return 0;
    const linhas = (Array.isArray(bills) ? bills : [])
      .map(normalizarBill)
      .filter(Boolean)
      .map((b) => ({ ...b, grupo_id: grupoId, cartao_id: cartaoId, atualizado_em: new Date().toISOString() }));
    if (!linhas.length) return 0;
    const supabase = require('../db/supabase');
    const { error } = await supabase.from('of_faturas')
      .upsert(linhas, { onConflict: 'cartao_id,of_bill_id' });
    return error ? 0 : linhas.length;   // erro = migration 118 pendente
  } catch { return 0; }
}

/** Faturas guardadas de um cartão, da mais antiga pra mais nova. */
async function faturasDoCartao(cartaoId) {
  try {
    if (!cartaoId) return [];
    const supabase = require('../db/supabase');
    const { data, error } = await supabase.from('of_faturas')
      .select('of_bill_id, competencia, vencimento, fechamento, total, pago, minimo')
      .eq('cartao_id', cartaoId).order('vencimento', { ascending: true });
    return error ? [] : (data || []);
  } catch { return []; }
}

/** A fatura publicada de uma competência (ou `null`). */
async function faturaDaCompetencia(cartaoId, competencia) {
  try {
    if (!cartaoId || !competencia) return null;
    const supabase = require('../db/supabase');
    const { data, error } = await supabase.from('of_faturas')
      .select('of_bill_id, competencia, vencimento, fechamento, total, pago, minimo')
      .eq('cartao_id', cartaoId).eq('competencia', competencia).maybeSingle();
    return error ? null : (data || null);
  } catch { return null; }
}

/**
 * A qual competência pertence o `simulated_bill_total_amount`.
 *
 * ⚠️ ISTO É O CORAÇÃO DA CORREÇÃO. A doc da Polp define o campo como
 * "soma dos débitos SEM FATURA no ciclo atual (após o último
 * `bill_closing_date`, até +31 dias)". Ou seja: ele NÃO é "a fatura atual" —
 * é o ciclo imediatamente SEGUINTE ao da última fatura PUBLICADA.
 *
 * Quando o emissor publica em dia, os dois coincidem e ninguém percebe a
 * diferença. Quando o emissor atrasa (o Mercado Pago nunca publica a fatura
 * em aberto), o simulado passa a ser uma fatura que JÁ FECHOU — e pendurá-lo
 * na competência atual mostra o valor de uma fatura em cima dos lançamentos
 * de outra. Foi exatamente o que aconteceu: R$ 560,68 (a de agosto, fechada)
 * aparecendo como se fosse a de setembro.
 *
 * @param {Array} faturas  saída de `faturasDoCartao` (ordenada por vencimento)
 * @returns {string|null} 'YYYY-MM' ou null quando não há fatura publicada
 */
function competenciaDoSimulado(cartao, faturas) {
  const arr = (faturas || []).filter((f) => f && f.competencia);
  if (!arr.length) return null;
  const ultima = arr[arr.length - 1];
  return competenciaVizinha(cartao, ultima.competencia, 1);
}

module.exports = {
  normalizarBill, salvarFaturas, faturasDoCartao, faturaDaCompetencia,
  competenciaDoSimulado, pagoDaBill, money, cent,
};
