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
 * `payments[]` achatado, COM A DATA (migration 128).
 *
 * ⚠️ A data é o campo que decide a quem o pagamento pertence, e era jogado
 * fora — `pagoDaBill` soma só o valor. Em parte dos emissores o `payments[]`
 * de uma fatura são os pagamentos feitos DURANTE o ciclo dela, que quitam a
 * ANTERIOR. Confirmado no EQI BLACK: a fatura que fechou em 15/08 informa um
 * pagamento de R$ 4.359,17 feito em 20/07 — 26 dias antes de ela existir, e do
 * tamanho exato da fatura de julho.
 *
 * Guardar não muda cálculo nenhum: é a medição que falta pra corrigir com
 * segurança (as duas correções óbvias regridem — ver o cabeçalho da sql/128).
 */
function pagamentosDaBill(bill) {
  const arr = bill && Array.isArray(bill.payments) ? bill.payments : [];
  const linhas = arr.map((p) => {
    const valor = Math.abs(money(p && p.amount !== undefined ? p.amount : p) || 0);
    if (!valor) return null;
    return {
      valor: cent(valor),
      data: ymd(p && (p.paymentDate || p.payment_date)) || null,
      tipo: (p && (p.valueType || p.value_type)) || null,
      modo: (p && (p.paymentMode || p.payment_mode)) || null,
    };
  }).filter(Boolean);
  return linhas.length ? linhas : null;
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
    // Só guardado (migration 128) — nenhum cálculo lê isto ainda.
    pagamentos:   pagamentosDaBill(bill),
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
    let { error } = await supabase.from('of_faturas')
      .upsert(linhas, { onConflict: 'cartao_id,of_bill_id' });
    // ⚠️ Sem a migration 128 a coluna `pagamentos` não existe e o upsert INTEIRO
    // falha — levando junto o total das faturas, que é o que a tela mostra.
    // Mesma lição do `datas_manuais` no upsertWallet: tenta com tudo, repete
    // sem o campo novo.
    if (error) {
      const semNovo = linhas.map(({ pagamentos, ...resto }) => resto);
      ({ error } = await supabase.from('of_faturas')
        .upsert(semNovo, { onConflict: 'cartao_id,of_bill_id' }));
    }
    return error ? 0 : linhas.length;   // erro = migration 118 pendente
  } catch { return 0; }
}

/**
 * Quanto foi pago numa competência, atribuindo cada pagamento pela sua DATA.
 *
 * ⚠️ O `payments[]` que o emissor pendura numa fatura NÃO é o conjunto de
 * pagamentos daquela fatura — é o que passou pela conta enquanto ela era a
 * fatura publicada. Medido com as datas na mão, os dois desvios existem:
 *
 *   Mercado Pago · fatura 2026-07 (fecha 12/07, vence 17/07, total R$ 3,13)
 *     R$    3,13 @ 16/07  ← esta sim é dela
 *     R$ 2.243,60 @ 03/08  ← é de agosto
 *     R$   565,68 @ 09/08  ← é de agosto
 *     `pago` somava os três: R$ 2.812,41 numa fatura de R$ 3,13.
 *
 *   Cartão EQI BLACK · fatura 2026-08 (fecha 15/08, total R$ 3.517,11)
 *     R$ 4.359,17 @ 20/07  ← 26 dias ANTES de a fatura existir; é a de julho
 *
 * A atribuição usa `competenciaDoPagamento` — a fatura de vencimento mais
 * próximo da data do pagamento —, a MESMA regra que `registrarPagamentosDoOF`
 * já aplica nos pagamentos que viram transação. Uma regra só pros dois lados.
 *
 * Devolve `null` quando o cartão ainda não tem as datas gravadas (migration
 * 128 + um sync): aí quem chama mantém exatamente o comportamento anterior.
 */
function pagoPorCompetencia(cartao, faturas, competencia) {
  const comDatas = (faturas || []).filter((f) => f && Array.isArray(f.pagamentos) && f.pagamentos.length);
  if (!comDatas.length) return null;                 // sem dado → não opina
  if (!cartao || !cartao.dia_vencimento) return null; // sem ciclo não dá pra atribuir

  const { competenciaDoPagamento } = require('./faturaRollover');
  const vistos = new Set();
  let total = 0;
  for (const f of comDatas) {
    for (const p of f.pagamentos) {
      if (!p || !p.data || !p.valor) continue;
      // O mesmo pagamento aparece pendurado em mais de uma fatura — sem isto
      // ele seria contado uma vez por fatura em que o emissor o repetiu.
      const chave = `${p.data}|${p.valor}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      if (competenciaDoPagamento(cartao, p.data) === competencia) total += Number(p.valor) || 0;
    }
  }
  return cent(total);
}

/** Faturas guardadas de um cartão, da mais antiga pra mais nova. */
async function faturasDoCartao(cartaoId) {
  try {
    if (!cartaoId) return [];
    const supabase = require('../db/supabase');
    const COLS = 'of_bill_id, competencia, vencimento, fechamento, total, pago, minimo';
    // ⚠️ `pagamentos` é da migration 128. Pedir uma coluna que não existe faz o
    // select INTEIRO falhar — e sem faturas a tela perde o valor do banco. Por
    // isso: tenta com ela, repete sem.
    let { data, error } = await supabase.from('of_faturas')
      .select(`${COLS}, pagamentos`)
      .eq('cartao_id', cartaoId).order('vencimento', { ascending: true });
    if (error) {
      ({ data, error } = await supabase.from('of_faturas')
        .select(COLS).eq('cartao_id', cartaoId).order('vencimento', { ascending: true }));
    }
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
  competenciaDoSimulado, pagoDaBill, pagamentosDaBill, pagoPorCompetencia, money, cent,
};
