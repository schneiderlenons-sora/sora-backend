// =============================================================================
// EVAL — alterar uma transação: a aritmética do saldo.
//
// Pedido de cliente (Fábio, 05/10/2026): poder ALTERAR o lançamento pelo
// WhatsApp, e não só excluir.
//
// ⚠️ A REGRA JÁ EXISTIA dentro do `PUT /api/transacoes/:id`. Este eval existe
// pra provar duas coisas ao mesmo tempo:
//   1. que a extração pro serviço NÃO MUDOU o comportamento do painel
//      (§1, contra uma CÓPIA CONGELADA da lógica antiga); e
//   2. que os casos que o WhatsApp introduz (mudar valor, conta, tipo) saem
//      certos.
//
// Sem a parte 1 isto seria uma reescrita no escuro de código que mexe em
// dinheiro de 601 carteiras.
//
// Rodar: node evals/alterarTransacao.eval.js
// =============================================================================
const {
  efeitoNoSaldo, ajustesDeSaldo, planoDeAlteracao, especial, valorNativo, normNome,
} = require('../src/services/alterarTransacao');
const { ehPagamentoFatura } = require('../src/services/categorizar');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const perto = (a, b, m) => { if (!(Math.abs(Number(a) - Number(b)) < 0.005)) falhas.push(`${m} (esperado ~${b}, veio ${JSON.stringify(a)})`); };
const ok = (c, m) => { if (!c) falhas.push(m); };

// ── A LÓGICA ANTIGA, COPIADA DO PUT ANTES DA EXTRAÇÃO ───────────────────────
// Transcrita literalmente de `routes/transacoes.js` (commit anterior). É ela
// que define "regressão zero": o serviço tem de concordar caso a caso.
function ANTIGO(antes, tx) {
  const esp = (t) => !t || t.transferencia === true || ehPagamentoFatura(t.categoria) || t.categoria === 'Transferências';
  const out = [];
  if (!esp(antes) && !esp(tx)) {
    const valNat = (t) => Number(t.valor_moeda ?? t.valor) || 0;
    const efeito = (t) => (t.pago ? (t.tipo === 'Gasto' ? -1 : 1) * valNat(t) : 0);
    const push = (nome, delta) => { if (delta && nome) out.push({ nome, delta }); };
    const norm = (s) => String(s || '').trim().toLowerCase();
    if (norm(antes.carteira_nome) === norm(tx.carteira_nome)) {
      push(tx.carteira_nome, efeito(tx) - efeito(antes));
    } else {
      push(antes.carteira_nome, -efeito(antes));
      push(tx.carteira_nome, efeito(tx));
    }
  }
  return out;
}

const base = {
  id: 't1', id_curto: 'ab12cd', grupo_id: 'g',
  tipo: 'Gasto', categoria: 'Supermercado', valor: 50, observacao: 'mercado',
  carteira_nome: 'Nubank', pago: true, data: '2026-10-05T00:00:00+00:00',
  transferencia: false, moeda: null, valor_moeda: null,
};

console.log('-- 1. REGRESSAO ZERO contra a logica antiga do painel --');
{
  // Casos que cobrem cada ramo do `if` antigo.
  const cenarios = [
    ['valor sobe',            { valor: 80 }],
    ['valor desce',           { valor: 20 }],
    ['valor igual',           { valor: 50 }],
    ['troca de conta',        { carteira_nome: 'Itau' }],
    ['troca conta E valor',   { carteira_nome: 'Itau', valor: 90 }],
    ['pago -> pendente',      { pago: false }],
    ['pendente -> pago',      { pago: true }],
    ['tipo vira receita',     { tipo: 'Recebimento' }],
    ['so a categoria',        { categoria: 'iFood' }],
    ['so a descricao',        { observacao: 'feira' }],
    ['caixa alta na conta',   { carteira_nome: 'NUBANK' }],
    ['espaco na conta',       { carteira_nome: ' Nubank ' }],
    ['conta nula depois',     { carteira_nome: null }],
    ['moeda estrangeira',     { valor: 300, valor_moeda: 55, moeda: 'NOK' }],
    ['transferencia',         { transferencia: true }],
    ['categoria Fatura',      { categoria: 'Fatura' }],
    ['categoria Transferências', { categoria: 'Transferências' }],
  ];
  for (const [rot, patch] of cenarios) {
    // pendente de origem também, pra cobrir os dois lados do `pago`
    for (const antesPago of [true, false]) {
      const antes  = { ...base, pago: antesPago };
      const depois = { ...antes, ...patch };
      const novo = ajustesDeSaldo(antes, depois).ajustes;
      const velho = ANTIGO(antes, depois);
      eq(JSON.stringify(novo), JSON.stringify(velho),
        `1 "${rot}" (antes.pago=${antesPago}) diverge da logica antiga`);
    }
  }
  // E a origem transferência/fatura, que o antigo tratava pelo `antes`.
  for (const antesPatch of [{ transferencia: true }, { categoria: 'Fatura' }]) {
    const antes = { ...base, ...antesPatch };
    const depois = { ...antes, valor: 999 };
    eq(JSON.stringify(ajustesDeSaldo(antes, depois).ajustes), JSON.stringify(ANTIGO(antes, depois)),
      '1 origem especial diverge');
  }
}
console.log('  ok');

console.log('-- 2. pendente pesa ZERO no saldo --');
{
  // ⚠️ Gasto nao pago ainda nao saiu da conta. Mudar o valor dele nao pode
  // mexer em saldo nenhum — senao o "previsto" debitaria duas vezes quando
  // for confirmado.
  const antes  = { ...base, pago: false, valor: 50 };
  const depois = { ...antes, valor: 500 };
  eq(efeitoNoSaldo(antes), 0, '2 pendente pesa 0');
  eq(ajustesDeSaldo(antes, depois).ajustes.length, 0, '2 mudar valor de pendente nao mexe no saldo');

  // Mas confirmar o pagamento debita o valor NOVO, nao o antigo.
  const pago = { ...depois, pago: true };
  const aj = ajustesDeSaldo(antes, pago).ajustes;
  eq(aj.length, 1, '2 confirmar gera um ajuste');
  perto(aj[0].delta, -500, '2 debita o valor novo');
}
console.log('  ok');

console.log('-- 3. mudar o VALOR aplica so a diferenca --');
{
  const antes  = { ...base, valor: 50 };
  const depois = { ...antes, valor: 80 };
  const aj = ajustesDeSaldo(antes, depois).ajustes;
  eq(aj.length, 1, '3 um ajuste');
  eq(aj[0].nome, 'Nubank', '3 na conta certa');
  // Gasto de 50 vira 80: sai mais 30 da conta.
  perto(aj[0].delta, -30, '3 aplica a diferenca, nao o valor cheio');

  // ⚠️ O erro facil: aplicar o valor CHEIO debitaria 80 de uma conta que ja
  // tinha perdido 50 — some 50 reais do cliente a cada correcao.
  ok(aj[0].delta !== -80, '3 NAO debita o valor cheio');
}
console.log('  ok');

console.log('-- 4. trocar de CONTA estorna numa e aplica na outra --');
{
  const antes  = { ...base, carteira_nome: 'Nubank', valor: 50 };
  const depois = { ...antes, carteira_nome: 'Itau' };
  const aj = ajustesDeSaldo(antes, depois).ajustes;
  eq(aj.length, 2, '4 dois ajustes');
  eq(aj[0].nome, 'Nubank', '4 primeiro a conta antiga');
  perto(aj[0].delta, 50, '4 devolve o gasto pra conta antiga');
  eq(aj[1].nome, 'Itau', '4 depois a nova');
  perto(aj[1].delta, -50, '4 debita da conta nova');

  // ⚠️ A SOMA TEM DE SER ZERO: trocar de conta nao cria nem destroi dinheiro.
  perto(aj[0].delta + aj[1].delta, 0, '4 troca de conta e soma zero');
}
console.log('  ok');

console.log('-- 5. trocar conta E valor ao mesmo tempo --');
{
  const antes  = { ...base, carteira_nome: 'Nubank', valor: 50 };
  const depois = { ...antes, carteira_nome: 'Itau', valor: 80 };
  const aj = ajustesDeSaldo(antes, depois).ajustes;
  perto(aj[0].delta, 50, '5 devolve o valor ANTIGO pra conta antiga');
  perto(aj[1].delta, -80, '5 debita o valor NOVO da conta nova');
}
console.log('  ok');

console.log('-- 6. mesma conta escrita diferente NAO vira troca --');
{
  // O resto do projeto casa carteira por `ilike`; tratar "NUBANK" como outra
  // conta geraria um estorno e um debito na MESMA conta, por caminhos
  // diferentes — e em conta de Open Finance um dos dois seria pulado,
  // deixando o saldo torto.
  for (const nome of ['NUBANK', ' Nubank ', 'nubank']) {
    const antes  = { ...base, carteira_nome: 'Nubank', valor: 50 };
    const depois = { ...antes, carteira_nome: nome, valor: 80 };
    const aj = ajustesDeSaldo(antes, depois).ajustes;
    eq(aj.length, 1, `6 "${nome}" devia ser a MESMA conta`);
    perto(aj[0].delta, -30, `6 "${nome}" so a diferenca`);
  }
  eq(normNome(' NuBank '), 'nubank', '6 normNome');
}
console.log('  ok');

console.log('-- 7. transferencia e fatura NAO passam por aqui --');
{
  // Elas movem dinheiro pelo caminho proprio; contar de novo tiraria em dobro.
  for (const campo of [{ transferencia: true }, { categoria: 'Fatura' }, { categoria: 'Transferências' }]) {
    const antes  = { ...base, ...campo };
    const depois = { ...antes, valor: 999 };
    const r = ajustesDeSaldo(antes, depois);
    eq(r.ajustes.length, 0, `7 ${JSON.stringify(campo)} nao gera ajuste`);
    eq(r.motivo, 'transferencia_ou_fatura', '7 com motivo nomeado');
    ok(especial(antes), `7 especial(${JSON.stringify(campo)})`);
  }
  // ⚠️ E se a linha DEIXA de ser especial, tambem nao: o saldo dela nunca
  // passou por aqui, entao aplicar a diferenca inventaria dinheiro.
  const antes  = { ...base, transferencia: true };
  const depois = { ...base, transferencia: false };
  eq(ajustesDeSaldo(antes, depois).ajustes.length, 0, '7 virar comum nao gera ajuste');
}
console.log('  ok');

console.log('-- 8. moeda ESTRANGEIRA mexe no saldo com o valor NATIVO --');
{
  // `wallets.saldo` esta na moeda da CONTA; `valor` esta na base do grupo.
  // Numa conta em coroa, usar o real erraria ~45%.
  const antes  = { ...base, carteira_nome: 'Conta NOK', moeda: 'NOK', valor_moeda: 100, valor: 55 };
  const depois = { ...antes, valor_moeda: 150, valor: 82.5 };
  eq(valorNativo(antes), 100, '8 nativo e o valor_moeda');
  const aj = ajustesDeSaldo(antes, depois).ajustes;
  perto(aj[0].delta, -50, '8 a diferenca sai em COROA (50), nao em real (27,50)');
}
console.log('  ok');

console.log('-- 9. planoDeAlteracao: so mexe no que mudou --');
{
  const { patch, alterados } = planoDeAlteracao(base, { categoria: 'iFood' });
  eq(Object.keys(patch).join(','), 'categoria', '9 patch so com a categoria');
  eq(alterados.join(','), 'categoria', '9 lista o que mudou');

  // ⚠️ Mandar o MESMO valor nao conta como alteracao — senao a confirmacao
  // diria "mudei a categoria" sem ter mudado nada.
  const igual = planoDeAlteracao(base, { categoria: 'Supermercado', valor: 50 });
  eq(igual.alterados.length, 0, '9 valor igual nao e alteracao');
  eq(Object.keys(igual.patch).length, 0, '9 patch vazio');

  // undefined e null sao ignorados (campo nao citado).
  const nada = planoDeAlteracao(base, { valor: undefined, categoria: null });
  eq(nada.alterados.length, 0, '9 undefined/null ignorados');

  // Varios de uma vez.
  const multi = planoDeAlteracao(base, { valor: 80, descricao: 'Feira', conta: 'Itau' });
  eq(multi.alterados.sort().join(','), 'conta,descricao,valor', '9 tres campos');
  eq(multi.patch.observacao, 'Feira', '9 descricao vira observacao');
  eq(multi.patch.carteira_nome, 'Itau', '9 conta vira carteira_nome');
}
console.log('  ok');

console.log('-- 10. plano em conta ESTRANGEIRA move os DOIS valores --');
{
  // A pessoa fala o valor na moeda da CONTA (e o que ela ve). O da base
  // acompanha pela taxa JA CONGELADA na linha — nunca por cambio novo: a taxa
  // do dia da compra e a que vale.
  const tx = { ...base, carteira_nome: 'Conta NOK', moeda: 'NOK', valor_moeda: 100, valor: 55 };
  const { patch } = planoDeAlteracao(tx, { valor: 200 });
  eq(patch.valor_moeda, 200, '10 nativo vira 200');
  perto(patch.valor, 110, '10 a base dobra junto (taxa 0,55 congelada)');

  // Linha na base nao ganha valor_moeda do nada.
  const { patch: p2 } = planoDeAlteracao(base, { valor: 200 });
  eq(p2.valor, 200, '10 base muda');
  eq('valor_moeda' in p2, false, '10 e valor_moeda NAO entra no patch');
}
console.log('  ok');

console.log('-- 11. a DATA compara so o dia, nao o timestamp --');
{
  // `transacoes.data` e timestamptz; comparar a string inteira faria toda
  // edicao parecer mudanca de data.
  const r = planoDeAlteracao(base, { data: '2026-10-05' });
  eq(r.alterados.length, 0, '11 mesma data nao conta');
  const r2 = planoDeAlteracao(base, { data: '2026-10-06' });
  eq(r2.patch.data, '2026-10-06', '11 data diferente entra');
}
console.log('  ok');

console.log('-- 12. origem ESPECIAL com valor diferente: ainda nao mexe --');
{
  // ⚠️ ACHADO PELA MUTACAO. Meu caso anterior usava o MESMO valor dos
  // dois lados, entao a diferenca dava zero e o filtro escondia o erro:
  // trocar `especial(antes) || especial(depois)` por so `especial(depois)`
  // passava batido. Com valores diferentes, a guarda de ORIGEM aparece.
  const antes  = { ...base, transferencia: true, valor: 50 };
  const depois = { ...base, transferencia: false, valor: 500 };
  eq(ajustesDeSaldo(antes, depois).ajustes.length, 0, '12 transferencia -> comum NAO ajusta');

  // E o contrario: linha comum que vira transferencia.
  const a2 = { ...base, transferencia: false, valor: 50 };
  const d2 = { ...base, transferencia: true, valor: 500 };
  eq(ajustesDeSaldo(a2, d2).ajustes.length, 0, '12 comum -> transferencia NAO ajusta');

  // Mesma coisa pela CATEGORIA (pagamento de fatura).
  const a3 = { ...base, categoria: 'Fatura', valor: 50 };
  const d3 = { ...base, categoria: 'Supermercado', valor: 500 };
  eq(ajustesDeSaldo(a3, d3).ajustes.length, 0, '12 Fatura -> comum NAO ajusta');
  eq(ajustesDeSaldo(a3, d3).motivo, 'transferencia_ou_fatura', '12 com o motivo nomeado');

  // ⚠️ POR QUE ISSO IMPORTA: o saldo de uma transferencia nunca passou por
  // aqui (ela move dinheiro pelo caminho dela). Aplicar a diferenca ao
  // converte-la INVENTARIA os 450 de diferenca na conta do cliente.
}
console.log('  ok');
console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  .', f));
  process.exit(1);
}
console.log('OK alterarTransacao: regressao zero no painel + os casos novos do WhatsApp');
process.exit(0);
