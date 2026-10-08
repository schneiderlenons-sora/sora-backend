// =============================================================================
// EVAL — o handler de "alterar transação", executado de verdade.
//
// Pedido de cliente (Fábio, 05/10/2026): poder ALTERAR o lançamento pelo
// WhatsApp, não só excluir.
//
// ⚠️ EXECUTA O HANDLER, não só a aritmética. A lição desta semana foi
// exatamente essa: `eval:alterar-transacao` prova a conta do saldo, e ainda
// assim nada ali garante que o handler CHAMA a conta certa, grava o patch
// certo ou lê o erro do update. Supabase falso, mensageiro falso; o que se
// mede é o que a Sora ESCREVEU e o que ela RESPONDEU.
//
// Rodar: node evals/alterarTxHandler.eval.js
// =============================================================================
const Module = require('module');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-falso';

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const perto = (a, b, m) => { if (!(Math.abs(Number(a) - Number(b)) < 0.005)) falhas.push(`${m} (esperado ~${b}, veio ${JSON.stringify(a)})`); };
const ok = (c, m) => { if (!c) falhas.push(m); };

const TX = {
  id: 't1', id_curto: 'AB12CD', grupo_id: 'g',
  tipo: 'Gasto', categoria: 'Supermercado', valor: 50, observacao: 'mercado',
  carteira_nome: 'Nubank', pago: true, data: '2026-10-05T00:00:00+00:00',
  transferencia: false, moeda: null, valor_moeda: null,
};

/**
 * Roda o handler e devolve o que ele fez.
 *
 * @param data        o que o interpretador devolveu
 * @param tx          a linha que o banco tem (null = não existe)
 * @param wallets     carteiras do grupo
 * @param erroUpdate  true = o update falha
 * @param erroLer     true = o select falha
 * @param contaReal   o que `resolverCarteiraReal` devolve
 */
async function rodar({ data, tx = TX, wallets = [{ id: 'w1', nome: 'Nubank', saldo: 1000, of_conta_id: null }],
                       erroUpdate = false, erroLer = false, contaReal = undefined }) {
  const enviadas = [];
  const updates = [];
  const upserts = [];

  const fake = (nome) => {
    const q = {
      _patch: null, _upsert: null,
      select() { return q; }, eq() { return q; }, ilike() { return q; },
      order() { return q; }, limit() { return q; }, not() { return q; },
      update(p) { q._patch = p; return q; },
      upsert(p) { q._upsert = p; upserts.push({ t: nome, row: p }); return q; },
      insert() { return q; },
      maybeSingle: () => {
        if (nome === 'wallets') return Promise.resolve({ data: wallets[0] || null, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      single: () => {
        if (q._patch) {
          updates.push({ t: nome, patch: q._patch });
          if (erroUpdate) return Promise.resolve({ data: null, error: { message: 'falhou' } });
          return Promise.resolve({ data: { ...tx, ...q._patch }, error: null });
        }
        if (nome === 'grupos') return Promise.resolve({ data: { moeda_base: 'BRL' }, error: null });
        return Promise.resolve({ data: null, error: null });
      },
      then(res) {
        if (q._upsert) return res({ data: null, error: null });
        if (q._patch) { updates.push({ t: nome, patch: q._patch }); return res({ data: null, error: null }); }
        if (nome === 'transacoes') {
          if (erroLer) return res({ data: null, error: { message: 'select caiu' } });
          return res({ data: tx ? [tx] : [], error: null });
        }
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
        return new Proxy({}, {
          get: () => async (_p, texto) => { enviadas.push(String(texto)); return true; },
        });
      }
      return origLoad.call(this, req, parent, isMain);
    };
    const { alterarTx } = require('../src/handlers/alterarTx');
    const resolver = async (_g, nome) => (contaReal !== undefined ? contaReal : nome);
    await alterarTx({ phone: '5511999', grupoId: 'g', data, resolverCarteiraReal: resolver });
  } finally {
    Module._load = origLoad;
  }

  const patch = updates.find((u) => u.t === 'transacoes')?.patch || null;
  const saldo = updates.filter((u) => u.t === 'wallets').map((u) => u.patch);
  return { texto: enviadas.join('\n---\n'), patch, saldo, upserts };
}

(async () => {

console.log('-- 1. mudar o VALOR grava o patch e ajusta o saldo --');
{
  const r = await rodar({ data: { idCurto: 'AB12CD', mudancas: { valor: 80 } } });
  eq(r.patch?.valor, 80, '1 gravou o valor novo');
  eq(Object.keys(r.patch).join(','), 'valor', '1 so o valor no patch');
  // Gasto de 50 vira 80: sai mais 30 da conta (1000 - 30).
  eq(r.saldo.length, 1, '1 um ajuste de saldo');
  perto(r.saldo[0].saldo, 970, '1 aplicou a DIFERENCA, nao o valor cheio');
  ok(/alterada/i.test(r.texto), '1 confirmou');
}
console.log('  ok');

console.log('-- 2. a confirmacao mostra DE -> PARA --');
{
  // ⚠️ "Alterado!" sozinho obriga a pessoa a abrir o painel pra conferir — e e
  // justamente a conferencia que ela quer evitar.
  const r = await rodar({ data: { idCurto: 'AB12CD', mudancas: { valor: 80 } } });
  ok(r.texto.includes('50'), '2 mostra o valor ANTIGO');
  ok(r.texto.includes('80'), '2 mostra o valor NOVO');
  ok(r.texto.includes('AB12CD'), '2 nomeia a transacao');
}
console.log('  ok');

console.log('-- 3. mudar a CATEGORIA nao mexe em saldo --');
{
  const r = await rodar({ data: { idCurto: 'AB12CD', mudancas: { categoria: 'iFood' } } });
  eq(r.patch?.categoria, 'iFood', '3 gravou');
  eq(r.saldo.length, 0, '3 categoria nao mexe no saldo');
}
console.log('  ok');

console.log('-- 4. mudar a DESCRICAO grava em `observacao` --');
{
  // ⚠️ A coluna e `observacao`, nao `descricao` — e o nome que o cliente usa.
  const r = await rodar({ data: { idCurto: 'AB12CD', mudancas: { descricao: 'Corrida de Uber' } } });
  eq(r.patch?.observacao, 'Corrida de Uber', '4 grava em observacao');
  eq('descricao' in (r.patch || {}), false, '4 e NAO numa coluna "descricao"');
  ok(r.texto.includes('Corrida de Uber'), '4 confirma com a grafia que a pessoa escreveu');
}
console.log('  ok');

console.log('-- 5. conta que NAO existe: pergunta, nao cria --');
{
  // ⚠️ Criar a conta a partir de um nome digitado torto e como nascem as
  // contas duplicadas ("Nubnak"). Medido no projeto: conta-fantasma ja custou
  // tres portas fechadas.
  const r = await rodar({ data: { idCurto: 'AB12CD', mudancas: { conta: 'Nubnak' } }, contaReal: null });
  eq(r.patch, null, '5 nao gravou nada');
  eq(r.upserts.length, 0, '5 NAO criou carteira');
  ok(/nao achei a conta|não achei a conta/i.test(r.texto), '5 avisa');
  ok(r.texto.includes('Nubank'), '5 e LISTA as contas que existem');
}
console.log('  ok');

console.log('-- 6. transacao inexistente --');
{
  const r = await rodar({ data: { idCurto: 'ZZ99ZZ', mudancas: { valor: 10 } }, tx: null });
  eq(r.patch, null, '6 nao gravou');
  ok(/não achei|nao achei/i.test(r.texto), '6 avisa');
  ok(r.texto.includes('ZZ99ZZ'), '6 nomeia o codigo');
}
console.log('  ok');

console.log('-- 7. falha de LEITURA nao vira "nao achei" --');
{
  // ⚠️ A linha pode existir. Dizer que nao existe convida a pessoa a lancar de
  // novo — duplicando o gasto que ela so queria corrigir.
  const r = await rodar({ data: { idCurto: 'AB12CD', mudancas: { valor: 10 } }, erroLer: true });
  eq(r.patch, null, '7 nao gravou');
  ok(!/não achei|nao achei/i.test(r.texto), '7 NAO diz "nao achei"');
  ok(/tenta de novo|instantes/i.test(r.texto), '7 pede pra tentar de novo');
}
console.log('  ok');

console.log('-- 8. update que FALHA nao responde sucesso --');
{
  // ⚠️ A familia de bugs mais cara deste projeto: `const { data } = await ...`
  // sem ler o `error`, a gravacao falha e a resposta diz que deu certo.
  const r = await rodar({ data: { idCurto: 'AB12CD', mudancas: { valor: 80 } }, erroUpdate: true });
  ok(!/alterada/i.test(r.texto), '8 NAO diz que alterou');
  ok(/não consegui|nao consegui/i.test(r.texto), '8 diz que falhou');
  eq(r.saldo.length, 0, '8 e NAO mexe no saldo de uma gravacao que nao aconteceu');
}
console.log('  ok');

console.log('-- 9. sem campo citado: mostra o estado e os exemplos --');
{
  // ⚠️ Nao e erro — a intencao esta clara, so falta o que. "Nao entendi" faria
  // a pessoa desistir.
  const r = await rodar({ data: { idCurto: 'AB12CD', mudancas: {} } });
  eq(r.patch, null, '9 nao gravou');
  ok(r.texto.includes('Supermercado'), '9 mostra a categoria atual');
  ok(r.texto.includes('Nubank'), '9 mostra a conta atual');
  ok(r.texto.includes('mercado'), '9 mostra a descricao atual');
  ok(/altera AB12CD/i.test(r.texto), '9 ensina o formato com o id REAL');
}
console.log('  ok');

console.log('-- 10. mandar o valor que ja esta la nao "altera" --');
{
  const r = await rodar({ data: { idCurto: 'AB12CD', mudancas: { valor: 50 } } });
  eq(r.patch, null, '10 nao gravou');
  eq(r.saldo.length, 0, '10 nao mexeu no saldo');
  ok(/já está assim|ja esta assim/i.test(r.texto), '10 diz que nada mudou');
}
console.log('  ok');

console.log('-- 11. conta de OPEN FINANCE: a linha muda, o saldo NAO --');
{
  // Regra de ouro do projeto: em carteira com `of_conta_id` o saldo e do
  // BANCO. Mexer nele produz um numero que o proximo sync desfaz.
  const r = await rodar({
    data: { idCurto: 'AB12CD', mudancas: { valor: 80 } },
    wallets: [{ id: 'w1', nome: 'Nubank', saldo: 1000, of_conta_id: 'of-1' }],
  });
  eq(r.patch?.valor, 80, '11 a transacao MUDA normalmente');
  eq(r.saldo.length, 0, '11 e o saldo do banco fica intocado');
}
console.log('  ok');

console.log('-- 12. a ULTIMA transacao (sem id) --');
{
  const r = await rodar({ data: { idCurto: null, ultima: true, mudancas: { categoria: 'iFood' } } });
  eq(r.patch?.categoria, 'iFood', '12 alterou a ultima');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`x ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  .', f));
  process.exit(1);
}
console.log('OK alterarTxHandler: grava o certo, ajusta o saldo e nunca mente sucesso');
process.exit(0);
})();
