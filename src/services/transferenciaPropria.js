// =============================================================================
// TRANSFERÊNCIA ENTRE CONTAS PRÓPRIAS — o par saída × entrada.
//
// Relato (Vander, out/2026): R$ 11.900 saem do Inter PJ como "💰 Financeiro" e
// entram no BTG como "Transferência recebida". É ele movendo o próprio
// dinheiro — mas, sem a marca de transferência, a Sora conta o valor como
// DESPESA e como RECEITA, inflando os dois lados do resumo.
//
// FONTE ÚNICA da régua: o diagnóstico do /admin (diagnosticoFinanceiro) e o
// quadro "Movimentação entre suas contas?" da aba Transações chamam ESTA
// função. Duas réguas diriam coisas diferentes sobre o mesmo par.
//
// ⚠️ NUNCA AUTOMÁTICO — e isso foi MEDIDO, não suposto. Na base inteira a
// régua acha ~25 pares, e parte é coincidência: Pix de R$ 10 saindo do BTG pra
// uma pessoa no mesmo dia em que outra pessoa mandou R$ 10 pro Mercado Pago.
// Por isso ela só SUGERE, e o cliente confirma. Pra reduzir o ruído:
//   · só CONTA (cartão fica fora: pagamento de fatura tem regra própria);
//   · só a partir de R$ 50 (os falsos positivos medidos eram de R$ 10–40);
//   · até 1 dia de distância;
//   · par SEM DISPUTA dos dois lados (duas entradas iguais → não escolhe).
// =============================================================================

const diaNum = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).getTime() / 86400000;
const ehCartao = (w) => /cr[eé]dito/i.test(String((w && w.tipo) || ''));
const MINIMO = 50;

/**
 * @param transacoes  linhas (de um ou mais grupos)
 * @param wallets     carteiras dos mesmos grupos ({ grupo_id, nome, tipo })
 * @param ehTransferencia  a regra de resumoTransacoes (o que já não conta)
 * @returns [{ grupo_id, saida, entrada }]
 */
function paresTransferencia(transacoes, wallets, ehTransferencia, { minimo = MINIMO } = {}) {
  const carteira = new Map((wallets || []).map((w) => [`${w.grupo_id}|${w.nome}`, w]));
  // ⚠️ A ponta que JÁ é transferência continua elegível: o MEIO-PAR é o caso
  // real (Vander, R$ 5.500): a saída estava como "Transferências" e não
  // contava, mas a ENTRADA ("Transferência recebida") seguia somando como
  // receita. Descartar a ponta marcada escondia justamente a que sobrou. Só se
  // pula o par em que as DUAS já não contam (abaixo).
  const elegivel = (t) => t && t.id
    && Number(t.valor) >= minimo
    && carteira.has(`${t.grupo_id}|${t.carteira_nome}`)            // conta que existe
    && !ehCartao(carteira.get(`${t.grupo_id}|${t.carteira_nome}`));
  const porGrupo = new Map();
  for (const t of (transacoes || []).filter(elegivel)) {
    if (!porGrupo.has(t.grupo_id)) porGrupo.set(t.grupo_id, []);
    porGrupo.get(t.grupo_id).push(t);
  }
  const pares = [];
  for (const [grupoId, txs] of porGrupo) {
    const saidas = txs.filter((t) => t.tipo === 'Gasto');
    const entradas = txs.filter((t) => t.tipo === 'Recebimento');
    const casa = (s, e) => e.carteira_nome !== s.carteira_nome
      && Math.abs(Number(e.valor) - Number(s.valor)) < 0.005
      && Math.abs(diaNum(e.data) - diaNum(s.data)) <= 1;
    for (const s of saidas) {
      const cands = entradas.filter((e) => casa(s, e));
      if (cands.length !== 1) continue;                        // disputa → não escolhe
      const e = cands[0];
      if (saidas.filter((x) => casa(x, e)).length !== 1) continue; // disputa do outro lado
      if (ehTransferencia(s) && ehTransferencia(e)) continue;  // já resolvido: as duas fora
      pares.push({ grupo_id: grupoId, saida: s, entrada: e });
    }
  }
  return pares;
}

/** O par informado (por id) é, pela MESMA régua, uma transferência? */
function confirmaPar(saida, entrada, wallets, ehTransferencia) {
  if (!saida || !entrada || saida.grupo_id !== entrada.grupo_id) return false;
  if (saida.tipo !== 'Gasto' || entrada.tipo !== 'Recebimento') return false;
  // Re-checagem do par isolado: sem a disputa (o cliente já escolheu QUAL).
  return paresTransferencia([saida, entrada], wallets, ehTransferencia).length === 1;
}

module.exports = { paresTransferencia, confirmaPar, MINIMO };
