// =============================================================================
// EVAL — soltar a carteira do banco (devolver conta órfã ao uso manual).
//
// ⚠️ O ERRO CARO AQUI É SOLTAR UMA CARTEIRA COM CONEXÃO VIVA. O sync a
// recriaria no próximo passe e o histórico se partiria em duas contas — o
// estrago que já existe na base ("BTG Banking" 321 transações × "BTG Banking
// (OF)" 540) e que esta função existe para desfazer, não para repetir.
//
// Rodar: node evals/soltarCarteira.eval.js
// =============================================================================
const { podeSoltar, planoDeSoltar } = require('../src/services/soltarCarteira');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

const ORFA = { id: 'w1', nome: 'BTG Banking', of_conta_id: 'acc-1', of_consent_id: 'consent-morto' };
const VIVA = { id: 'w2', nome: 'Nubank', of_conta_id: 'acc-2', of_consent_id: 'consent-vivo' };
const MANUAL = { id: 'w3', nome: 'Dinheiro', of_conta_id: null, of_consent_id: null };
const vivos = (...ids) => new Set(ids);

console.log('-- 1. carteira ORFA pode ser solta --');
{
  const r = podeSoltar(ORFA, vivos('consent-vivo'));
  eq(r.pode, true, '§1 o consentimento dela nao esta na lista de vivos');
}
console.log('  ok');

console.log('-- 2. CONEXAO VIVA NAO solta (o sync recriaria a conta) --');
{
  const r = podeSoltar(VIVA, vivos('consent-vivo', 'outro'));
  eq(r.pode, false, '§2 recusa');
  eq(r.motivo, 'conexao_viva', '§2 com motivo proprio');
  eq(/Desconecte/.test(r.erro), true, '§2 e diz o que fazer antes');
}
console.log('  ok');

console.log('-- 3. SEM A LISTA DE CONEXOES, NAO SOLTA --');
{
  // Falha de leitura nao pode virar "entao esta orfa": seria soltar uma conta
  // viva por causa de um solucho de rede.
  for (const semLista of [null, undefined, [], 'erro', 0, {}]) {
    const r = podeSoltar(ORFA, semLista);
    eq(r.pode, false, `§3 ${JSON.stringify(semLista)} -> recusa`);
    eq(r.motivo, 'conexoes_indisponiveis', `§3 ${JSON.stringify(semLista)} motivo certo`);
  }
  // Um Set VAZIO e resposta legitima ("nenhuma conexao viva"), nao ausencia.
  eq(podeSoltar(ORFA, new Set()).pode, true, '§3 Set vazio = nenhuma conexao viva -> solta');
}
console.log('  ok');

console.log('-- 4. carteira que JA e manual --');
{
  const r = podeSoltar(MANUAL, vivos());
  eq(r.pode, false, '§4 recusa (nao ha o que soltar)');
  eq(r.motivo, 'ja_manual', '§4 com motivo proprio');
}
console.log('  ok');

console.log('-- 5. carteira inexistente --');
{
  const r = podeSoltar(null, vivos());
  eq(r.pode, false, '§5 recusa');
  eq(r.motivo, 'nao_encontrada', '§5 com motivo proprio');
}
console.log('  ok');

console.log('-- 6. LEGADA sem consentimento gravado: pode soltar --');
{
  // Nenhum sync a reivindica, entao nao ha risco de recriacao.
  const legada = { id: 'w9', nome: 'Itaú', of_conta_id: 'acc-9', of_consent_id: null };
  eq(podeSoltar(legada, vivos('consent-vivo')).pode, true, '§6 sem consent -> solta');
}
console.log('  ok');

console.log('-- 7. o patch mexe SO nos vinculos --');
{
  const p = planoDeSoltar();
  eq(Object.keys(p).sort().join(','), 'of_consent_id,of_conta_id', '§7 exatamente 2 campos');
  eq(p.of_conta_id, null, '§7 zera a conta do banco');
  eq(p.of_consent_id, null, '§7 e o consentimento');
  // ⚠️ nome e saldo FORA: as transacoes casam por `carteira_nome`, e mexer no
  // nome aqui transformaria 2.370 lancamentos em conta-fantasma.
  eq('nome' in p, false, '§7 NAO toca no nome');
  eq('saldo' in p, false, '§7 NAO toca no saldo');
  eq('tipo' in p, false, '§7 NAO toca no tipo');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('OK soltarCarteira: solta a orfa e NUNCA uma com conexao viva');
process.exit(0);
