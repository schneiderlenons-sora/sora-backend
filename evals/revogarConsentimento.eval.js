// =============================================================================
// eval:revogar-consentimento — a revogação na Polp tem de DIZER quando falhou.
//
// ⚠️ POR QUE EXISTE: `revogarConsentimento` engolia toda falha e devolvia null.
// O `exigirRevogacao: true` de services/desconectarConexao (corte de excedente,
// exclusão de conta, desconectar pelo admin) apagava a linha achando que a Polp
// tinha confirmado — o consentimento seguia vivo, cobrado, e sem rastro na base.
// O eval do corte não pegava: lá o PROVEDOR é mock e o mock lança. Aqui o
// cliente é o REAL e só o `fetch` é falso — testa o caminho, não o stub.
// =============================================================================
const assert = require('assert');
const Module = require('module');

process.env.POLP_CELCOIN_CLIENT_ID = 'x';
process.env.POLP_CELCOIN_CLIENT_SECRET = 'y';

let resposta = { status: 200, corpo: { message: 'Consentimento revogado.' } };
const chamadas = [];
global.fetch = async (url, init) => {
  chamadas.push({ url, method: init?.method });
  if (resposta === 'rede') throw new Error('ECONNRESET');
  const { status, corpo } = resposta;
  return {
    ok: status >= 200 && status < 300, status, statusText: String(status),
    headers: { get: () => null },
    text: async () => JSON.stringify(corpo || {}),
    json: async () => corpo || {},
  };
};

// Banco falso só pro desconectarConexao.
const apagadas = [];
const arquivadas = [];
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (/db\/supabase$/.test(req)) {
    return {
      from: (t) => ({
        insert: async (row) => { arquivadas.push({ t, row }); return { error: null }; },
        delete: () => ({ eq: async (_c, v) => { apagadas.push({ t, v }); return { error: null }; } }),
      }),
    };
  }
  return origLoad.call(this, req, parent, isMain);
};

const celcoin = require('../src/services/polpCelcoin');
const providers = require('../src/services/openFinanceProvider');
const { desconectarConexao } = require('../src/services/desconectarConexao');

let ok = 0, falhou = 0;
async function caso(nome, fn) {
  try { await fn(); ok++; console.log('  ✓', nome); }
  catch (e) { falhou++; console.log('  ✗', nome, '—', e.message); }
}

(async () => {
  console.log('\n§1 cliente da Celcoin');
  await caso('200 → devolve a confirmação', async () => {
    resposta = { status: 200, corpo: { message: 'Consentimento revogado.' } };
    const r = await celcoin.revogarConsentimento('c1', { estrito: true });
    assert.strictEqual(r.message, 'Consentimento revogado.');
    assert.strictEqual(chamadas.at(-1).method, 'DELETE');
    assert.ok(chamadas.at(-1).url.endsWith('/consents/c1'));
  });
  await caso('404 estrito → conta como revogado (a Polp não conhece = não cobra)', async () => {
    resposta = { status: 404, corpo: { message: 'not found' } };
    const r = await celcoin.revogarConsentimento('c1', { estrito: true });
    assert.deepStrictEqual(r, { jaRevogado: true });
  });
  await caso('500 estrito → LANÇA', async () => {
    resposta = { status: 500, corpo: { message: 'erro interno' } };
    await assert.rejects(() => celcoin.revogarConsentimento('c1', { estrito: true }), /500/);
  });
  await caso('falha de rede estrita → LANÇA', async () => {
    resposta = 'rede';
    await assert.rejects(() => celcoin.revogarConsentimento('c1', { estrito: true }), /rede/);
  });
  await caso('500 sem estrito → null (rota do usuário não vira 500)', async () => {
    resposta = { status: 500, corpo: { message: 'erro interno' } };
    assert.strictEqual(await celcoin.revogarConsentimento('c1'), null);
  });

  console.log('\n§2 provedor repassa o modo');
  await caso('provedor celcoin com { estrito } lança no 500', async () => {
    resposta = { status: 500, corpo: {} };
    await assert.rejects(() => providers.para('polp-celcoin').removerConexao('c2', { estrito: true }));
  });

  console.log('\n§3 desconectarConexao({ exigirRevogacao: true }) — o caminho do corte');
  const conexao = { id: 'row-1', external_id: 'c3', provider: 'polp-celcoin', grupo_id: 'g', user_id: 'u' };
  await caso('Polp recusa → NÃO apaga a linha nem arquiva', async () => {
    resposta = { status: 500, corpo: { message: 'fora do ar' } };
    apagadas.length = 0; arquivadas.length = 0;
    const r = await desconectarConexao({ conexao, motivo: 'admin', exigirRevogacao: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.revogada, false);
    assert.strictEqual(apagadas.length, 0, 'apagou a linha com o consentimento vivo na Polp');
    assert.strictEqual(arquivadas.length, 0);
  });
  await caso('Polp confirma → arquiva e apaga', async () => {
    resposta = { status: 200, corpo: { message: 'Consentimento revogado.' } };
    apagadas.length = 0; arquivadas.length = 0;
    const r = await desconectarConexao({ conexao, motivo: 'admin', exigirRevogacao: true });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(apagadas, [{ t: 'of_conexoes', v: 'row-1' }]);
    assert.strictEqual(arquivadas[0].row.motivo, 'admin');
  });
  await caso('já revogado na Polp (404) → apaga (não há o que cobrar)', async () => {
    resposta = { status: 404, corpo: {} };
    apagadas.length = 0;
    const r = await desconectarConexao({ conexao, motivo: 'admin', exigirRevogacao: true });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(apagadas.length, 1);
  });
  await caso('caminho do USUÁRIO segue apagando mesmo com a Polp fora', async () => {
    resposta = { status: 500, corpo: {} };
    apagadas.length = 0;
    const r = await desconectarConexao({ conexao, motivo: 'usuario' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(apagadas.length, 1);
  });

  console.log(`\n${ok} ok · ${falhou} falharam`);
  process.exit(falhou ? 1 : 0);
})();
