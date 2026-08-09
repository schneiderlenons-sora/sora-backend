// =====================================================================
// Quanto uma transação soma NA FATURA do cartão — fonte única da regra.
//
// BUG QUE ISTO CORRIGE (relatado por cliente Nubank, ago/2026): a fatura só
// sabia SOMAR. Todo crédito — estorno, cashback, "Crédito de parcelamento de
// compra" — era simplesmente DESCARTADO do cálculo, nunca subtraído. Um
// estorno de R$ 40 deixava a fatura da Sora R$ 40 maior que a do banco, pra
// sempre. O cliente conferia lançamento por lançamento todo mês.
//
// A regra estava copiada em SETE lugares (sync, rollover, card do cartão,
// limite comprometido, histórico, modal de detalhes e o card do dashboard),
// todos com `tipo === 'Gasto'` cravado. Agora a aritmética mora aqui e é
// espelhada FIELMENTE em `sora-frontend/lib/valor-fatura.ts` — mexeu num,
// mexa no outro e rode `npm run eval:valor-fatura` nos dois.
//
// ⚠️ A REGRA É DELIBERADAMENTE ESTREITA. Só abate quando a linha é
// `Recebimento` **E** `transferencia = true` **E** não é pagamento de fatura.
// Medido na base inteira antes de subir: ZERO linhas existentes mudam de
// valor. O que fica de fora de propósito são os `Recebimento` com
// `transferencia = false` em carteira de crédito (medidos: 1 "Salário" de
// R$ 300 lançado errado e 8 "📦 Importado" de OFX, um deles de R$ 2.129,45
// que tem cara de pagamento de fatura). Abater esse último seria contar duas
// vezes com `pagamentos_fatura` — é exatamente o erro que a condição evita.
// =====================================================================

const { ehPagamentoFatura } = require('./categorizar');

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * É a categoria do PAGAMENTO da fatura?
 *
 * Reforça o `ehPagamentoFatura` do catálogo: aquele compara a string EXATA
 * ('Fatura' / 'Fatura cartão'), então `'💳 Fatura'` devolvia **false**. Aqui
 * um falso negativo é caro — a linha viraria abatimento e a fatura cairia
 * indevidamente —, então tiramos emoji/acento antes de comparar.
 */
function ehPagamentoFaturaCat(categoria) {
  if (ehPagamentoFatura(categoria)) return true;
  const limpo = String(categoria || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')       // tira acento
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')                     // tira emoji e pontuação
    .toLowerCase().replace(/\s+/g, ' ').trim();
  return limpo === 'fatura' || limpo === 'fatura cartao';
}

/**
 * Quanto esta linha soma na fatura do ciclo.
 *
 *   compra (Gasto)              → +valor
 *   "Fatura anterior" (rollover)→ +valor   (é Gasto com transferencia=true)
 *   pagamento da fatura         →  0       (abate via `pagamentos_fatura`,
 *                                           contar aqui seria em dobro)
 *   estorno / cashback / crédito→ −valor
 *   qualquer outro Recebimento  →  0       (ver o aviso do topo)
 */
function valorNaFatura(t) {
  if (!t) return 0;
  const v = Math.abs(Number(t.valor) || 0);

  if (t.tipo === 'Gasto') return v;
  if (t.tipo !== 'Recebimento') return 0;

  // Só crédito RECONHECIDO pelo sync abate. `transferencia` é a flag que o
  // normalize marca em pagamento de fatura E em crédito/estorno; sem ela a
  // linha é um recebimento comum que alguém lançou na carteira do cartão.
  if (t.transferencia !== true) return 0;

  if (ehPagamentoFaturaCat(t.categoria)) return 0;
  return -v;
}

/** Soma a fatura de uma lista já filtrada pelo ciclo. Nunca devolve negativo. */
function somarFatura(transacoes) {
  const total = (transacoes || []).reduce((s, t) => s + valorNaFatura(t), 0);
  return Math.max(0, cent(total));
}

module.exports = { valorNaFatura, somarFatura, ehPagamentoFaturaCat, cent };
