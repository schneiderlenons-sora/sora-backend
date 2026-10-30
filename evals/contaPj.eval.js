// =============================================================================
// EVAL: conta de EMPRESA do Open Finance nasce "… PJ", não "… (OF)".
//
// Caso de origem (Robert, out/2026): conectou a conta PJ do Mercado Pago; como
// já existia a pessoal "Mercado Pago", a nova virou "Mercado Pago (OF)" no meio
// das pessoais, ele leu como "não conectou" e desconectou a conta que funcionava.
//
// O que este eval trava:
//   1. a regra do nome (pura): PJ no fim, ou antes de "Crédito"; não repete
//      quando o banco já diz "empresa"; corta o NOME, nunca o "PJ";
//   2. ⚠️ SEM a marca de empresa, o nome é EXATAMENTE o de antes (regressão
//      zero pra toda conexão pessoal e pra toda conexão anterior à 188);
//   3. upsertWallet com banco falso: conta nova de empresa nasce "… PJ" mesmo
//      com a pessoal de mesmo nome já conectada;
//   4. ⚠️ a conta PJ NÃO ADOTA a carteira manual PESSOAL de mesmo nome do banco
//      (antes ela era engolida por ela, misturando empresa e pessoal) — adota
//      só uma manual "… PJ";
//   5. carteira já vinculada (mesmo of_conta_id) NUNCA é renomeada;
//   6. só o FATO do CNPJ conta (14 dígitos), e null/ausente = pessoal.
//
// Rodar:  npm run eval:conta-pj
// =============================================================================
const path = require('path');
const { nomeDaContaOf, conexaoEmpresarial, informouCnpj } = require('../src/services/nomeContaOf');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

// ── 1. a regra do nome ────────────────────────────────────────────────────
console.log('── 1. regra do nome ──');
eq(nomeDaContaOf('Mercado Pago', { empresarial: true }), 'Mercado Pago PJ', 'conta corrente PJ');
eq(nomeDaContaOf('Mercado Pago Crédito', { empresarial: true }), 'Mercado Pago PJ Crédito', 'cartão PJ: PJ antes de Crédito');
eq(nomeDaContaOf('Itaú Credito', { empresarial: true }), 'Itaú PJ Credito', 'cartão sem acento');
eq(nomeDaContaOf('Banco do Brasil Poupança', { empresarial: true }), 'Banco do Brasil Poupança PJ', 'poupança PJ');
eq(nomeDaContaOf('Itaú Empresas', { empresarial: true }), 'Itaú Empresas', 'banco já diz "empresa": não repete');
eq(nomeDaContaOf('Conta PJ Inter', { empresarial: true }), 'Conta PJ Inter', 'já tem PJ: não repete');
eq(nomeDaContaOf('Nubank Negócios', { empresarial: true }), 'Nubank Negócios', 'já diz negócios');
eq(nomeDaContaOf('', { empresarial: true }), 'Conta PJ', 'sem nome');
const longo = 'B'.repeat(70);
eq(nomeDaContaOf(longo, { empresarial: true }).length, 60, 'nunca passa de 60');
eq(nomeDaContaOf(longo, { empresarial: true }).endsWith(' PJ'), true, 'corta o nome, nunca o PJ');
const longoCartao = 'C'.repeat(70) + ' Crédito';
eq(nomeDaContaOf(longoCartao, { empresarial: true }).endsWith(' PJ Crédito'), true, 'cartão longo mantém "PJ Crédito"');
eq(nomeDaContaOf(longoCartao, { empresarial: true }).length <= 60, true, 'cartão longo cabe em 60');
console.log('  ok');

// ── 2. regressão zero sem a marca ─────────────────────────────────────────
console.log('── 2. ⚠️ sem a marca de empresa, nada muda ──');
for (const n of ['Mercado Pago', 'Mercado Pago Crédito', 'Itaú Empresas', 'Nubank']) {
  eq(nomeDaContaOf(n), n, `"${n}" sem opções`);
  eq(nomeDaContaOf(n, { empresarial: false }), n, `"${n}" com empresarial=false`);
  eq(nomeDaContaOf(n, { empresarial: null }), n, `"${n}" com empresarial=null (conexão anterior à 188)`);
  eq(nomeDaContaOf(n, { empresarial: 'true' }), n, `"${n}" com string "true" não conta`);
}
console.log('  ok');

// ── 6. o fato do CNPJ ─────────────────────────────────────────────────────
console.log('── 6. o fato do CNPJ ──');
eq(informouCnpj('12.345.678/0001-90'), true, 'CNPJ formatado');
eq(informouCnpj('12345678000190'), true, 'CNPJ só dígitos');
eq(informouCnpj(''), false, 'vazio');
eq(informouCnpj(undefined), false, 'ausente (conexão pessoal)');
eq(informouCnpj('123.456.789-09'), false, 'CPF não é CNPJ');
eq(conexaoEmpresarial({ empresarial: true }), true, 'marca gravada');
eq(conexaoEmpresarial({ empresarial: null }), false, 'anterior à 188');
eq(conexaoEmpresarial({}), false, 'sem a coluna (188 pendente)');
eq(conexaoEmpresarial(null), false, 'sem conexão');
console.log('  ok');

// ── banco falso pro upsertWallet ──────────────────────────────────────────
function bancoFalso(walletsIniciais) {
  const wallets = walletsIniciais.map((w) => ({ ...w }));
  let seq = 100;
  function from(tabela) {
    if (tabela !== 'wallets') throw new Error('tabela inesperada: ' + tabela);
    const filtros = [];
    let modo = 'select', patch = null, novo = null;
    const casa = (w) => filtros.every((f) => f(w));
    const api = {
      select() { return api; },
      eq(k, v) { filtros.push((w) => w[k] === v); return api; },
      ilike(k, v) { filtros.push((w) => String(w[k] || '').toLowerCase() === String(v).toLowerCase()); return api; },
      is(k, v) { filtros.push((w) => (w[k] ?? null) === v); return api; },
      update(p) { modo = 'update'; patch = p; return api; },
      insert(r) { modo = 'insert'; novo = r; return api; },
      async maybeSingle() { return { data: wallets.find(casa) || null, error: null }; },
      async single() {
        if (modo === 'insert') {
          if (wallets.some((w) => w.grupo_id === novo.grupo_id && w.nome === novo.nome)) {
            return { data: null, error: { message: 'duplicate key (grupo_id, nome)' } };
          }
          const linha = { id: `w${seq++}`, ...novo };
          wallets.push(linha);
          return { data: linha, error: null };
        }
        return { data: wallets.find(casa) || null, error: null };
      },
      then(res, rej) {   // update(...).eq(...) é aguardado direto
        if (modo === 'update') wallets.filter(casa).forEach((w) => Object.assign(w, patch));
        return Promise.resolve({ data: null, error: null }).then(res, rej);
      },
    };
    return api;
  }
  return { client: { from }, wallets };
}

function carregarSync(banco) {
  const alvo = path.resolve(__dirname, '../src/services/polpCelcoinSync.js');
  const db = path.resolve(__dirname, '../src/db/supabase.js');
  delete require.cache[alvo];
  require.cache[db] = { id: db, filename: db, loaded: true, exports: banco.client };
  return require(alvo);
}

const G = 'grupo-1';
const contaPessoalOF = { id: 'w1', grupo_id: G, nome: 'Mercado Pago', of_conta_id: 'of-pessoal', tipo: 'Corrente', saldo: 27 };
const contaDoBanco = (ext, nome = 'Mercado Pago', tipo = 'Corrente') => ({ externalId: ext, nome, tipo, extras: {} });

(async () => {
  // ── 3. o caso do Robert ─────────────────────────────────────────────────
  console.log('── 3. conta PJ nova, com a pessoal já conectada ──');
  {
    const b = bancoFalso([contaPessoalOF]);
    const { upsertWallet } = carregarSync(b);
    const nome = await upsertWallet(G, 'u1', contaDoBanco('of-pj'), 3779.56, 'consent-pj', { empresarial: true });
    eq(nome, 'Mercado Pago PJ', 'nasce "Mercado Pago PJ"');
    eq(b.wallets.some((w) => w.nome === 'Mercado Pago (OF)'), false, 'nada de "(OF)"');
    eq(b.wallets.find((w) => w.id === 'w1').nome, 'Mercado Pago', 'a pessoal fica como estava');
    const cartao = await upsertWallet(G, 'u1', contaDoBanco('of-pj-cc', 'Mercado Pago Crédito', 'Crédito'), -100, 'consent-pj', { empresarial: true });
    eq(cartao, 'Mercado Pago PJ Crédito', 'cartão PJ');
  }
  {
    // A MESMA situação sem a marca: o comportamento antigo, intacto.
    const b = bancoFalso([contaPessoalOF]);
    const { upsertWallet } = carregarSync(b);
    const nome = await upsertWallet(G, 'u1', contaDoBanco('of-2'), 10, 'consent-2');
    eq(nome, 'Mercado Pago (OF)', 'sem a marca, o desempate de antes segue igual');
  }
  console.log('  ok');

  // ── 4. adoção ───────────────────────────────────────────────────────────
  console.log('── 4. ⚠️ a conta PJ não engole a manual pessoal ──');
  {
    const manualPessoal = { id: 'w9', grupo_id: G, nome: 'Mercado Pago', of_conta_id: null, tipo: 'Corrente', saldo: 500 };
    const b = bancoFalso([manualPessoal]);
    const { upsertWallet } = carregarSync(b);
    const nome = await upsertWallet(G, 'u1', contaDoBanco('of-pj'), 3779.56, 'consent-pj', { empresarial: true });
    eq(nome, 'Mercado Pago PJ', 'cria a PJ à parte');
    eq(b.wallets.find((w) => w.id === 'w9').of_conta_id, null, 'a manual pessoal NÃO foi vinculada ao banco da empresa');
    eq(b.wallets.find((w) => w.id === 'w9').saldo, 500, 'nem teve o saldo trocado');
  }
  {
    const manualPj = { id: 'w8', grupo_id: G, nome: 'Mercado Pago PJ', of_conta_id: null, tipo: 'Corrente', saldo: 0 };
    const b = bancoFalso([manualPj]);
    const { upsertWallet } = carregarSync(b);
    const nome = await upsertWallet(G, 'u1', contaDoBanco('of-pj'), 3779.56, 'consent-pj', { empresarial: true });
    eq(nome, 'Mercado Pago PJ', 'adota a manual "… PJ"');
    eq(b.wallets.find((w) => w.id === 'w8').of_conta_id, 'of-pj', 'vinculou a manual PJ');
    eq(b.wallets.length, 1, 'sem carteira duplicada');
  }
  {
    // Conexão PESSOAL continua adotando a manual pessoal, como sempre.
    const manualPessoal = { id: 'w9', grupo_id: G, nome: 'Mercado Pago', of_conta_id: null, tipo: 'Corrente', saldo: 500 };
    const b = bancoFalso([manualPessoal]);
    const { upsertWallet } = carregarSync(b);
    await upsertWallet(G, 'u1', contaDoBanco('of-p'), 600, 'consent-p');
    eq(b.wallets.find((w) => w.id === 'w9').of_conta_id, 'of-p', 'conexão pessoal adota a manual pessoal (de sempre)');
  }
  console.log('  ok');

  // ── 5. carteira já vinculada ────────────────────────────────────────────
  console.log('── 5. carteira já vinculada nunca é renomeada ──');
  {
    const jaVinculada = { id: 'w5', grupo_id: G, nome: 'Mercado Pago (OF)', of_conta_id: 'of-pj', tipo: 'Corrente', saldo: 1 };
    const b = bancoFalso([contaPessoalOF, jaVinculada]);
    const { upsertWallet } = carregarSync(b);
    const nome = await upsertWallet(G, 'u1', contaDoBanco('of-pj'), 2, 'consent-pj', { empresarial: true });
    eq(nome, 'Mercado Pago (OF)', 'devolve o nome que já tem');
    eq(b.wallets.find((w) => w.id === 'w5').nome, 'Mercado Pago (OF)', 'o nome no banco não mudou');
    eq(b.wallets.length, 2, 'não criou outra');
  }
  console.log('  ok');

  console.log('');
  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ conta PJ do Open Finance: todos os casos passaram');
})().catch((e) => { console.error(e); process.exit(1); });
