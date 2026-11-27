// =============================================================================
// MARCAÇÃO DE FATURA DO EMISSOR (`bill_forecast_date` → `transacoes.of_bill_forecast`)
// e a FATURA ABERTA CONFERIDA PELO LIMITE. Regras puras (eval:fatura-conferida).
//
// Por que existe (relato do Breno, 27/11/2026): a fatura em aberto do Nubank e
// do Mercado Pago saía errada porque a Sora calcula `limite usado − a faturar
// depois` (regra de ouro) e os dois lados vinham tortos:
//   · Mercado Pago: o `unbilled_amount` da Polp vem 0. Pela fórmula documentada
//     ("bill_post_date posterior a bill_closing_date + 1 mês"), parcela futura
//     — que a própria doc diz vir com bill_post_date "0001-01-01" — NUNCA entra.
//     A tela mostrava o limite usado inteiro, com R$ 464,41 de jan/fev.
//   · Nubank: o banco manda VÁRIAS linhas de limite; a que soma tudo (917,42)
//     não era a que a Sora lia (830,98). Faltavam R$ 86,44.
//
// A marcação do emissor resolve os dois, mas NÃO serve pra todo banco (medido
// em 27/11: discorda da tela em 84 de 109 cartões). Por isso ela só vale quando
// é CONFERIDA por uma segunda fonte independente do próprio banco:
//
//     fatura aberta pela marcação (M) + o que está marcado pra depois (F)
//         = used_amount de ALGUMA linha de limite, AO CENTAVO
//
// Duas fontes do banco batendo ao centavo não é coincidência. Medido em
// 27/11/2026 nos 81 cartões com conexão viva: 10 conferem; em 6 a tela já
// mostrava M (a regra concorda onde a tela acerta) e 4 mudam — os 2 do relato
// (Nubank 500,36 → 586,80 e Mercado Pago 1.995,42 → 1.531,01, os valores do
// app do banco), um Itaú Click que somava 10 parcelas futuras na fatura atual
// (367,80 → 112,30) e um Nubank com uma compra lançada depois do fechamento
// (1.871,90 → 1.795,23). Os outros 71 não mudam.
// =============================================================================
const { ehPagamentoFaturaCat } = require('./valorFatura');

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;

// Pagamento da fatura gravado com outra categoria (regra do cliente, "Outros",
// o "PAGTO.BOLETO" da Caixa) — medido em 27/11/2026: 19 linhas em 5 grupos.
const RE_PAGAMENTO = /pagamento\s+(da\s+|de\s+)?fatura|pagamento\s+recebido|obrigado\s+pelo\s+pagamento|pagamento\s+(com\s+saldo|on\s*-?\s*line|debito\s+automatico)|\bpagto\b|\bpgto\b/i;

function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036F]/g, '');
}

/** A linha é o PAGAMENTO de uma fatura (e não um estorno/crédito)? */
function ehPagamentoDeFatura(t) {
  if (!t || t.tipo !== 'Recebimento') return false;
  return ehPagamentoFaturaCat(t.categoria) || RE_PAGAMENTO.test(semAcento(t.observacao));
}

/** Quanto a linha pesa numa fatura: compra +, crédito −, pagamento 0. */
function pesoNaFatura(t) {
  const v = Math.abs(Number(t.valor_moeda ?? t.valor) || 0);   // na moeda do CARTÃO
  if (t.tipo === 'Gasto') return v;
  if (t.tipo !== 'Recebimento') return 0;
  return ehPagamentoDeFatura(t) ? 0 : -v;
}

const mesDaMarca = (t) => String((t && t.of_bill_forecast) || '').slice(0, 7);

/**
 * Fatura da `competencia` pela marcação do EMISSOR: linhas SEM bill_id (ainda
 * não faturadas) marcadas pra ela. O pagamento fica fora (quita a anterior).
 * @returns {{ valor: number, linhas: number }}
 */
function somaPelaMarcaDoBanco(linhas, competencia) {
  let soma = 0, n = 0;
  for (const t of linhas || []) {
    if (!t || t.of_bill_id) continue;
    if (mesDaMarca(t) !== competencia) continue;
    if (t.tipo !== 'Gasto' && t.tipo !== 'Recebimento') continue;
    if (ehPagamentoDeFatura(t)) continue;
    soma += pesoNaFatura(t); n++;
  }
  return { valor: cent(soma), linhas: n };
}

/** O que o emissor marcou pra competências DEPOIS da `competencia` (sem bill_id). */
function futurasPelaMarca(linhas, competencia) {
  let soma = 0;
  for (const t of linhas || []) {
    if (!t || t.of_bill_id) continue;
    const m = mesDaMarca(t);
    if (!/^\d{4}-\d{2}$/.test(m) || m <= competencia) continue;
    soma += pesoNaFatura(t);
  }
  return cent(soma);
}

/** Os `used_amount` (positivos, distintos) de todas as linhas de limite. */
function usadosDoLimite(limits, money) {
  const out = new Set();
  for (const l of Array.isArray(limits) ? limits : []) {
    const v = money(l && l.used_amount);
    if (v != null && v > 0) out.add(cent(v));
  }
  return [...out];
}

/**
 * A fatura aberta pela marcação, SÓ se conferida pelo limite do banco.
 * @param {{ linhas: Array, competencia: string, usados: number[] }} p
 * @returns {null | { valor: number, futuras: number, usado: number }}
 */
function faturaConferidaPeloLimite({ linhas, competencia, usados }) {
  if (!/^\d{4}-\d{2}$/.test(String(competencia || ''))) return null;
  const M = somaPelaMarcaDoBanco(linhas, competencia);
  const F = futurasPelaMarca(linhas, competencia);
  // Fatura negativa (crédito do cliente) fica com a regra de sempre.
  if (M.valor < 0) return null;
  const total = cent(M.valor + F);
  if (!(total > 0)) return null;
  // AO CENTAVO: é a coincidência exata das duas fontes que dá a garantia.
  // (< 0,005 é só a margem do ponto flutuante: um centavo de diferença já recusa.)
  const usado = (usados || []).find((u) => Math.abs(cent(u) - total) < 0.005);
  if (usado == null) return null;
  return { valor: M.valor, futuras: F, usado: cent(usado) };
}

module.exports = {
  ehPagamentoDeFatura, pesoNaFatura, somaPelaMarcaDoBanco, futurasPelaMarca,
  usadosDoLimite, faturaConferidaPeloLimite,
};
