// =============================================================================
// EVAL — o handler de SALVAR grava a grafia certa e mostra a descrição.
//
// Sugestões 002 e 003 do cliente (Fábio, 05/10/2026).
//
// ⚠️ EXECUTA O HANDLER. `eval:descricao-tx` prova que as duas funções estão
// certas, e isso não garante nada sobre o lançamento real: elas só valem se o
// handler CHAMAR a primeira na gravação e a segunda na confirmação, e com os
// argumentos certos. Foi exatamente esse buraco — função certa, caminho não
// testado — que deixou a cotação morta em produção esta semana.
//
// Rodar: node evals/salvarDescricao.eval.js
// =============================================================================
const Module = require('module');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-falso';

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const ok = (c, m) => { if (!c) falhas.push(m); };

const WALLET = { id: 'w1', nome: 'Nubank', tipo: 'Corrente', saldo: 1000, of_conta_id: null, ativo: true };

/**
 * Roda o `handleTransacoes` com acao=salvar e devolve o que ele gravou e disse.
 *
 * @param data      o que o interpretador devolveu
 * @param mensagem  a frase ORIGINAL (é dela que sai a grafia)
 */
async function salvar({ data, mensagem, wallets = [WALLET] }) {
  const enviadas = [];
  const inserts = [];

  const fake = (nome) => {
    const q = {
      _insert: null, _patch: null,
      select() { return q; }, eq() { return q; }, ilike() { return q; }, in() { return q; },
      order() { return q; }, limit() { return q; }, not() { return q; }, gte() { return q; },
      lte() { return q; }, lt() { return q; }, is() { return q; }, or() { return q; },
      insert(p) { q._insert = p; inserts.push({ t: nome, row: p }); return q; },
      upsert(p) { q._insert = p; return q; },
      update(p) { q._patch = p; return q; },
      delete() { return q; },
      maybeSingle: () => {
        if (nome === 'wallets') return Promise.resolve({ data: wallets[0] || null, error: null });
        if (nome === 'grupos') return Promise.resolve({ data: { moeda_base: 'BRL' }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      single: () => {
        if (q._insert) return Promise.resolve({ data: { id: 'tx1', ...q._insert }, error: null });
        if (nome === 'wallets') return Promise.resolve({ data: wallets[0] || null, error: null });
        if (nome === 'grupos') return Promise.resolve({ data: { moeda_base: 'BRL' }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then(res) {
        if (q._insert || q._patch) return res({ data: null, error: null });
        if (nome === 'wallets') return res({ data: wallets, error: null });
        return res({ data: [], error: null });
      },
    };
    return q;
  };

  const origLoad = Module._load;
  try {
    for (const k of Object.keys(require.cache)) {
      if (/sora-backend[\\/]src[\\/]/.test(k)) delete require.cache[k];
    }
    Module._load = function (req, parent, isMain) {
      if (req.endsWith('db/supabase')) return { from: fake };
      if (req.endsWith('services/mensageiro')) {
        return new Proxy({}, { get: () => async (_p, texto) => { enviadas.push(String(texto)); return true; } });
      }
      // Não interessa aqui, e cada um faria ida de rede ou consulta extra.
      if (req.endsWith('services/limites')) return { verificarLimite: async () => {} };
      if (req.endsWith('services/ia')) return { analisarGastos: async () => '' };
      return origLoad.call(this, req, parent, isMain);
    };
    const handle = require('../src/handlers/transacoes');
    await handle(
      { acao: 'salvar', tipo: 'Gasto', valor: 25, categoria: 'Transporte', ...data },
      { phone: '5511999', grupoId: 'g', user: { id: 'u1', wallet_padrao_id: 'w1' }, mensagem },
    );
  } finally {
    Module._load = origLoad;
  }

  const tx = inserts.find((i) => i.t === 'transacoes')?.row || null;
  return { tx, texto: enviadas.join('\n---\n') };
}

(async () => {

console.log('-- 1. 003: GRAVA a grafia que a pessoa escreveu --');
{
  // ⚠️ O caso EXATO do relato. Antes gravava "corrida de uber".
  const r = await salvar({
    data: { observacao: 'corrida de uber', carteira_nome: 'Nubank' },
    mensagem: 'Gastei 25 com Corrida de Uber',
  });
  ok(!!r.tx, '1 gravou a transacao');
  eq(r.tx?.observacao, 'Corrida de Uber', '1 a grafia foi preservada NA GRAVACAO');
}
console.log('  ok');

console.log('-- 2. 002: a CONFIRMACAO mostra a descricao --');
{
  const r = await salvar({
    data: { observacao: 'corrida de uber', carteira_nome: 'Nubank' },
    mensagem: 'Gastei 25 com Corrida de Uber',
  });
  ok(/Descrição: Corrida de Uber/.test(r.texto), '2 a linha esta na mensagem');
  // E continua mostrando tudo que ja mostrava.
  ok(/Categoria/.test(r.texto), '2 categoria segue');
  ok(/Valor/.test(r.texto), '2 valor segue');
  ok(/Conta/.test(r.texto), '2 conta segue');
  ok(/ID/.test(r.texto), '2 id segue');
  ok(/excluir transação/i.test(r.texto), '2 e o "para desfazer" segue');
}
console.log('  ok');

console.log('-- 3. descricao IGUAL a categoria nao vira linha --');
{
  // "uber 18": descricao "uber", categoria "Uber". A linha nao informaria
  // nada e so alongaria a confirmacao.
  const r = await salvar({
    data: { observacao: 'uber', categoria: 'Uber', carteira_nome: 'Nubank' },
    mensagem: 'uber 18',
  });
  eq(/Descrição:/.test(r.texto), false, '3 sem linha redundante');
  ok(/Categoria: Uber/.test(r.texto), '3 mas a categoria aparece');
}
console.log('  ok');

console.log('-- 4. lancamento SEM descricao nao ganha linha vazia --');
{
  const r = await salvar({
    data: { observacao: '', categoria: 'Outros', carteira_nome: 'Nubank' },
    mensagem: 'gastei 25',
  });
  eq(/Descrição:/.test(r.texto), false, '4 sem linha');
  eq(r.tx?.observacao, '', '4 e grava vazio, nao null');
}
console.log('  ok');

console.log('-- 5. acento volta na gravacao E na confirmacao --');
{
  const r = await salvar({
    data: { observacao: 'refeicao no acougue', carteira_nome: 'Nubank' },
    mensagem: 'Gastei 25 com Refeição no Açougue',
  });
  eq(r.tx?.observacao, 'Refeição no Açougue', '5 gravou com acento');
  ok(r.texto.includes('Refeição no Açougue'), '5 e mostrou com acento');
}
console.log('  ok');

console.log('-- 6. descricao inventada pela IA ganha a inicial --');
{
  // "50 no ze delivery" -> a IA resume como "bebida": nao ha o que recuperar.
  const r = await salvar({
    data: { observacao: 'bebida', categoria: 'Zé Delivery', carteira_nome: 'Nubank' },
    mensagem: '50 no zé delivery',
  });
  eq(r.tx?.observacao, 'Bebida', '6 inicial maiuscula');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  .', f));
  process.exit(1);
}
console.log('OK salvarDescricao: o handler grava a grafia certa e mostra a descricao');
process.exit(0);
})();
