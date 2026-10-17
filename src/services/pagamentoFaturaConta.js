// =============================================================================
// PAGAMENTO DE FATURA QUE SÓ APARECE NA CONTA CORRENTE.
//
// O caso que o CLAUDE.md registrava como "medido, NÃO corrigido": o cliente
// paga a fatura por débito na conta, e o pagamento NUNCA chega pelo cartão
// (o emissor não manda a transação, ou o cartão é manual). Nada vai pra
// `pagamentos_fatura`, e a fatura fica "vencida em aberto" pra sempre —
// enquanto a saída da conta conta como GASTO, em cima das compras do cartão
// que já contaram (dobro).
//
// Medido em 16/10/2026: das 171 faturas vencidas em aberto da base, 7 têm UMA
// saída de conta no valor exato da fatura, entre o fechamento e 7 dias depois
// do vencimento — todas com cara de pagamento ("PGTO PEND CARTAO", "NEON
// PAGAMENTOS", "Fatura Cartão Sicoob"). Zero ambíguas.
//
// ⚠️ SÓ SUGERE. "Mesmo valor" é forte mas não é prova: o cliente confirma.
// ⚠️ PAR SEM DISPUTA nos dois lados — uma saída que serviria pra duas faturas,
//    ou uma fatura com duas saídas candidatas, não é sugerida.
// =============================================================================

const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;
const dia = (d) => String(d || '').slice(0, 10);
const ehCartao = (w) => /cr[eé]dito/i.test(String((w && w.tipo) || ''));
const DIAS_APOS_VENC = 7;

function somaDias(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * A saída `t` pode ser o pagamento da fatura `f`?
 * f = { cartao_id, competencia, fatura, restante, fim (fechamento), venc }
 */
function saidaPagaFatura(t, f) {
  if (!t || !f || t.tipo !== 'Gasto') return false;
  if (!(Number(f.restante) > 0.01)) return false;
  const v = cent(t.valor);
  const bateValor = Math.abs(v - cent(f.restante)) < 0.005 || Math.abs(v - cent(f.fatura)) < 0.005;
  if (!bateValor) return false;
  const d = dia(t.data);
  return d > dia(f.fim) && d <= somaDias(dia(f.venc), DIAS_APOS_VENC);
}

/**
 * Pares (saída da conta × fatura em aberto) sem ambiguidade.
 *
 * @param saidas   Gastos do grupo (já filtrados pra contas, não cartões)
 * @param faturas  faturas FECHADAS com restante > 0 ({ cartao_id, cartao_nome,
 *                 competencia, fatura, restante, fim, venc })
 * @param jaVinculadas  Set de transacao_id já em pagamentos_fatura
 * @returns [{ saida, fatura }]
 */
function paresPagamentoFatura(saidas, faturas, jaVinculadas = new Set()) {
  const ss = (saidas || []).filter((t) => t && t.id && !jaVinculadas.has(t.id));
  const fs = (faturas || []).filter(Boolean);
  const pares = [];
  for (const f of fs) {
    const cands = ss.filter((t) => saidaPagaFatura(t, f));
    if (cands.length !== 1) continue;                          // fatura com 2 saídas: não escolhe
    const t = cands[0];
    if (fs.filter((g) => saidaPagaFatura(t, g)).length !== 1) continue; // saída que serve pra 2 faturas
    pares.push({ saida: t, fatura: f });
  }
  return pares;
}

/** Filtra as saídas elegíveis: Gasto, em CONTA (não cartão) que existe. */
function saidasDeConta(transacoes, wallets) {
  const tipo = new Map((wallets || []).map((w) => [`${w.grupo_id}|${w.nome}`, w]));
  return (transacoes || []).filter((t) => t && t.tipo === 'Gasto'
    && tipo.has(`${t.grupo_id}|${t.carteira_nome}`)
    && !ehCartao(tipo.get(`${t.grupo_id}|${t.carteira_nome}`)));
}

module.exports = { saidaPagaFatura, paresPagamentoFatura, saidasDeConta, DIAS_APOS_VENC, somaDias };
