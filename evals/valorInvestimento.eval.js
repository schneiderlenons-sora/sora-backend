// =============================================================================
// EVAL — atualizar o VALOR ATUAL de um investimento à mão.
//
// Pedido (kalebe, out/2026): "como faço pra adicionar lucro dos investimentos".
// Medido na conta dele: CDB de R$ 10.500 e uma Petrobrás, ambos com
// `valor_atual` IGUAL ao `valor_aportado`. Renda fixa não tem cotação pública,
// então não havia caminho nenhum.
//
// ⚠️ O ERRO CARO AQUI É MEXER NO `valor_aportado`. Ele é quanto a pessoa
// colocou do bolso; tocá-lo apaga o lucro em vez de registrá-lo e estraga a
// rentabilidade da carteira inteira. Metade deste eval é sobre ele NÃO mudar.
//
// Rodar: node evals/valorInvestimento.eval.js
// =============================================================================
const { planoDeAtualizarValor, rentabilidadeDe } = require('../src/services/valorInvestimento');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const perto = (a, b, m) => { if (Math.abs(a - b) > 1e-9) falhas.push(`${m} (esperado ~${b}, veio ${a})`); };

const CDB = { id: 'i1', nome: 'CDB 102%', ticker: null, valor_aportado: 10500, valor_atual: 10500 };

console.log('-- 1. o caso do relato: CDB que rendeu --');
{
  const r = planoDeAtualizarValor(CDB, 11000);
  eq(r.erro, undefined, '§1 aceita');
  eq(r.patch.valor_atual, 11000, '§1 grava o valor novo');
  // ⚠️ O QUE NAO PODE MUDAR NUNCA.
  eq('valor_aportado' in r.patch, false, '§1 NAO TOCA no valor_aportado');
  perto(r.patch.rentabilidade, (11000 - 10500) / 10500, '§1 recalcula a rentabilidade');
  eq(typeof r.patch.ultima_atualizacao, 'string', '§1 e marca quando foi');
  eq(r.temporario, false, '§1 sem ticker, o valor fica');
}
console.log('  ok');

console.log('-- 2. a RENTABILIDADE e coluna, nao conta da tela --');
{
  // InvestimentosClient le `i.rentabilidade` pro "maior ganho"/"maior perda":
  // nao regravar deixaria os dois cards apontando pro ativo errado.
  perto(rentabilidadeDe(11000, 10500), 0.047619047619047616, '§2 lucro');
  perto(rentabilidadeDe(10000, 10500), -0.047619047619047616, '§2 PREJUIZO fica negativo');
  perto(rentabilidadeDe(10500, 10500), 0, '§2 empate = zero');
  // ⚠️ sem aporte nao ha percentual: dividir por zero daria Infinity.
  eq(rentabilidadeDe(500, 0), 0, '§2 aporte zero -> 0, nunca Infinity');
  eq(rentabilidadeDe(500, null), 0, '§2 aporte null idem');
  eq(Number.isFinite(rentabilidadeDe(500, 0)), true, '§2 e o resultado e finito');
}
console.log('  ok');

console.log('-- 3. valor invalido e RECUSADO (nao grava lixo) --');
{
  for (const v of [0, -1, -0.01, null, undefined, '', '   ', 'abc', NaN, Infinity, -Infinity, {}, []]) {
    const r = planoDeAtualizarValor(CDB, v);
    eq(!!r.erro, true, `§3 ${JSON.stringify(v)} recusado`);
    eq(r.patch, undefined, `§3 ${JSON.stringify(v)} nao gera patch`);
  }
  // ⚠️ ZERO e recusado de proposito: existe investimento que virou po, mas
  // isso se resolve com resgate/exclusao — nao se informa por engano.
  eq(planoDeAtualizarValor(CDB, 0).motivo, 'valor_invalido', '§3 zero tem motivo proprio');
}
console.log('  ok');

console.log('-- 4. numero em TEXTO (vem do corpo JSON) --');
{
  const r = planoDeAtualizarValor(CDB, '11000');
  eq(r.patch.valor_atual, 11000, '§4 string numerica vira numero');
  eq(typeof r.patch.valor_atual, 'number', '§4 e e number, nao string');
  // centavos
  const c = planoDeAtualizarValor(CDB, 10500.55);
  eq(c.patch.valor_atual, 10500.55, '§4 centavos preservados');
}
console.log('  ok');

console.log('-- 5. investimento inexistente --');
{
  const r = planoDeAtualizarValor(null, 100);
  eq(!!r.erro, true, '§5 recusa');
  eq(r.motivo, 'nao_encontrado', '§5 com motivo proprio');
  eq(r.patch, undefined, '§5 sem patch');
}
console.log('  ok');

console.log('-- 6. ativo COM ticker: aceita, mas avisa que e temporario --');
{
  // A Petrobras dele, se tivesse ticker: `POST /atualizar-precos` regrava na
  // proxima passada. Nao e recusa (pode ser o que a pessoa quer com a bolsa
  // fechada), mas a tela precisa dizer — senao o numero "volta sozinho".
  const acao = { id: 'i2', nome: 'Petrobrás', ticker: 'PETR4', valor_aportado: 675, valor_atual: 675 };
  const r = planoDeAtualizarValor(acao, 700);
  eq(r.erro, undefined, '§6 aceita');
  eq(r.temporario, true, '§6 e avisa que a cotacao vai sobrescrever');
  eq('valor_aportado' in r.patch, false, '§6 e segue sem tocar no aportado');
}
{
  // ticker vazio/espaco nao conta como ticker
  for (const t of ['', '   ', null, undefined]) {
    const r = planoDeAtualizarValor({ ...CDB, ticker: t }, 11000);
    eq(r.temporario, false, `§6 ticker ${JSON.stringify(t)} -> nao e temporario`);
  }
}
console.log('  ok');

console.log('-- 7. o patch tem SO o que deve ter --');
{
  const r = planoDeAtualizarValor(CDB, 11000);
  const chaves = Object.keys(r.patch).sort().join(',');
  eq(chaves, 'rentabilidade,ultima_atualizacao,valor_atual', '§7 exatamente 3 campos');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('OK valorInvestimento: registra o lucro sem nunca tocar no aportado');
process.exit(0);
