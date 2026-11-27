// =============================================================================
// EVAL — o provedor do Open Finance falhando (500/rede) não pode virar dano.
//
// Relato de 27/11/2026: a lista de CARTÕES respondeu 500, a sincronização
// inteira abortou, a tela disse "Erro no login" com o texto técnico e o botão
// "Autorizar" — que, sem conseguir ler o consentimento, o RECRIARIA (e recriar
// um consentimento autorizado revoga a conexão que funciona).
//
// Roda o cliente, o sync e as rotas REAIS, com a rede e o banco falsos.
// Rodar:  npm run eval:instabilidade-of
// =============================================================================
process.env.SUPABASE_URL = 'http://falso.local';
process.env.SUPABASE_KEY = 'falso';
process.env.POLP_CELCOIN_CLIENT_ID = 'id';
process.env.POLP_CELCOIN_CLIENT_SECRET = 'segredo';
process.env.POLP_CELCOIN_API_URL = 'http://polp.falsa/api/v2';

const path = require('path');

// ── Banco falso: guarda toda escrita; leitura devolve vazio ──────────────────
const escritas = [];
let CONEXAO = null;
function from(tabela) {
  let op = 'select', dado = null, unica = false;
  const q = new Proxy({}, {
    get(_, nome) {
      if (nome === 'then') {
        return (ok, ruim) => {
          if (op !== 'select') escritas.push({ tabela, op, dado });
          const data = tabela === 'of_conexoes' && op === 'select' && unica ? CONEXAO : (unica ? null : []);
          return Promise.resolve({ data, error: null, count: 0 }).then(ok, ruim);
        };
      }
      return (arg) => {
        if (['update', 'insert', 'upsert', 'delete'].includes(nome)) { op = nome; dado = arg ?? null; }
        if (nome === 'maybeSingle' || nome === 'single') unica = true;
        return q;
      };
    },
  });
  return q;
}
const alvoDb = require.resolve(path.join(__dirname, '../src/db/supabase'));
require.cache[alvoDb] = { id: alvoDb, filename: alvoDb, loaded: true, exports: { from, rpc: async () => ({ data: null, error: null }) } };

// ── Rede falsa ──────────────────────────────────────────────────────────────
const chamadas = [];
let responder = () => ({ status: 200, corpo: { data: [] } });
global.fetch = async (url, opts = {}) => {
  const metodo = opts.method || 'GET';
  const caminho = String(url).replace('http://polp.falsa/api/v2', '').split('?')[0];
  chamadas.push(`${metodo} ${caminho}`);
  const r = responder(metodo, caminho, chamadas.filter((c) => c === `${metodo} ${caminho}`).length);
  if (r.rede) throw new Error('socket hang up');
  return {
    ok: r.status < 400, status: r.status, statusText: String(r.status), headers: { get: () => '0.001' },
    text: async () => (r.corpo ? JSON.stringify(r.corpo) : ''),
    json: async () => r.corpo,
  };
};

const celcoin = require('../src/services/polpCelcoin');
celcoin.ESPERAS_INSTABILIDADE.splice(0, 2, 1, 1);   // sem esperar de verdade
const { sincronizarConsentimento } = require('../src/services/polpCelcoinSync');
const { criarRepetidor } = require('../src/services/repetirSyncOF');
const { erroDeSyncParaCliente, INSTAVEL, OUTRO } = require('../src/services/erroDeSyncOF');
const providers = require('../src/services/openFinanceProvider');

const falhas = [];
let total = 0;
const eq = (a, b, m) => { total++; if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push(`${m}\n      esperado ${JSON.stringify(b)}\n      veio     ${JSON.stringify(a)}`); };
const vezes = (c) => chamadas.filter((x) => x === c).length;
const zerar = () => { chamadas.length = 0; escritas.length = 0; };

(async () => {
  // ── §1 O cliente repete LEITURA que falhou no provedor ────────────────────
  zerar();
  responder = (_m, _c, n) => (n < 3 ? { status: 500 } : { status: 200, corpo: { data: [{ id: 1 }] } });
  eq((await celcoin.listarCartoes('c1')).length, 1, '§1 500, 500, 200 → entrega o dado');
  eq(chamadas.length, 3, '§1 foram 3 tentativas');

  for (const st of [500, 502, 503]) {
    zerar();
    responder = () => ({ status: st });
    let erro = null;
    try { await celcoin.listarCartoes('c1'); } catch (e) { erro = e; }
    eq([chamadas.length, erro && erro.status, celcoin.ehInstabilidade(erro)], [3, st, true], `§1 ${st} sempre → desiste na 3ª e é instabilidade`);
  }
  zerar();
  responder = (_m, _c, n) => (n < 2 ? { rede: true } : { status: 200, corpo: { data: [] } });
  await celcoin.listarCartoes('c1');
  eq(chamadas.length, 2, '§1 queda de rede também é repetida');
  zerar();
  responder = () => ({ rede: true });
  let erroRede = null;
  try { await celcoin.listarCartoes('c1'); } catch (e) { erroRede = e; }
  eq([chamadas.length, celcoin.ehInstabilidade(erroRede)], [3, true], '§1 rede fora → instabilidade depois de 3');

  for (const st of [400, 403, 404, 422]) {
    zerar();
    responder = () => ({ status: st, corpo: { message: 'x' } });
    let erro = null;
    try { await celcoin.listarCartoes('c1'); } catch (e) { erro = e; }
    eq([chamadas.length, celcoin.ehInstabilidade(erro)], [1, false], `§1 ${st} é recusa: uma chamada só, não é instabilidade`);
  }
  zerar();
  responder = () => ({ status: 500 });
  try { await celcoin.api('/consents', { method: 'POST', body: {} }); } catch { /* esperado */ }
  eq(chamadas.length, 1, '§1 POST NUNCA é repetido (criaria consentimento em dobro)');
  zerar();
  responder = () => ({ rede: true });
  try { await celcoin.api('/consents/x', { method: 'DELETE' }); } catch { /* esperado */ }
  eq(chamadas.length, 1, '§1 DELETE também não');
  eq(celcoin.ehInstabilidade(new celcoin.CelcoinError('não configurado')), false, '§1 falta de configuração não é instabilidade');
  eq(celcoin.ehInstabilidade(new Error('qualquer')), false, '§1 erro nosso não é instabilidade');

  // ── §2 Caixinha: falha SOBE (devolver [] apagava as do cliente) ───────────
  zerar();
  responder = () => ({ status: 500 });
  let subiu = false;
  try { await celcoin.listarSaldosReservados('a1'); } catch { subiu = true; }
  eq(subiu, true, '§2 reserved-balances que falha lança erro');

  // ── §3 O sync inteiro ─────────────────────────────────────────────────────
  const ID = 'consent-1';
  const consent = (status = 'AUTHORISED') => ({ status: 200, corpo: { data: { id: ID, status } } });
  const conta = { id: 'acc1', brand_name: 'Itaú', type: 'CONTA_DEPOSITO_A_VISTA', balance: { available_amount: { amount: '10.00', currency: 'BRL' }, has_reserved_balance: true } };
  const rodar = async (mapa) => {
    zerar();
    CONEXAO = { id: 'cx1', external_id: ID, grupo_id: 'g1', user_id: 'u1', instituicao: 'Itaú', status: 'updated', importar_desde: null };
    responder = (m, c) => {
      for (const [fim, r] of Object.entries(mapa)) if (c.endsWith(fim)) return r;
      if (c === `/consents/${ID}`) return consent();
      return { status: 200, corpo: { data: [] } };
    };
    const r = await sincronizarConsentimento(ID, { dias: 90 });
    const upd = escritas.filter((e) => e.tabela === 'of_conexoes' && e.op === 'update' && !('recursos' in e.dado)).map((e) => e.dado);
    return { r, upd };
  };

  // O caso do relato: cartões 500.
  let { r, upd } = await rodar({ '/credit-cards': { status: 500 } });
  eq(r.erro, undefined, '§3 relato: o sync não aborta');
  eq((r.falhas || []).map((f) => f.parte), ['cartoes'], '§3 relato: diz qual parte faltou');
  eq(upd.length, 1, '§3 relato: uma atualização da conexão');
  eq(upd[0].status, 'updated', '§3 relato: a conexão NÃO vira erro');
  eq('ultima_sync' in upd[0], false, '§3 relato: ultima_sync não anda (não veio tudo)');
  eq(/credit-cards → 500/.test(upd[0].ultimo_erro), true, '§3 relato: o motivo técnico fica gravado');
  for (const parte of ['loans', 'financings', 'funds', 'variable-incomes']) {
    eq(vezes(`GET /consents/${ID}/${parte}`) >= 1, true, `§3 relato: ${parte} continuou sendo lido`);
  }
  eq(vezes(`GET /consents/${ID}/resources`), 0, '§3 relato: lista que falhou não é "sem cartão"');

  ({ r, upd } = await rodar({ '/accounts': { status: 503 } }));
  eq([(r.falhas || []).map((f) => f.parte), vezes(`GET /consents/${ID}/credit-cards`)], [['contas'], 1], '§3 contas fora do ar: os cartões ainda vêm');

  ({ r, upd } = await rodar({ '/accounts': { status: 500 }, '/credit-cards': { status: 500 } }));
  eq([(r.falhas || []).length, upd[0].status, 'ultima_sync' in upd[0]], [2, 'updated', false], '§3 as duas fora do ar');

  // Tudo certo: igual a antes.
  ({ r, upd } = await rodar({}));
  eq([r.falhas, r.erro, upd[0].status, upd[0].ultimo_erro, typeof upd[0].ultima_sync], [undefined, undefined, 'updated', null, 'string'], '§3 sucesso: igual a antes');
  eq(vezes(`GET /consents/${ID}/resources`), 1, '§3 sucesso sem cartão: segue perguntando os recursos');

  // Recusa (4xx) segue virando erro, como antes.
  ({ r, upd } = await rodar({ '/credit-cards': { status: 403, corpo: { message: 'CONSENT_INACTIVE' } } }));
  eq([!!r.erro, upd[0].status], [true, 'error'], '§3 recusa 403 continua erro');

  // Consentimento que não deu pra ler: o status não é tocado.
  ({ r, upd } = await rodar({ [`/consents/${ID}`]: { status: 500 }, '/credit-cards': { status: 500 } }));
  eq(['status' in upd[0], 'ultima_sync' in upd[0]], [false, false], '§3 sem confirmar o consentimento, o status fica como estava');

  // Caixinha com falha não apaga nada.
  ({ r, upd } = await rodar({ [`/consents/${ID}/accounts`]: { status: 200, corpo: { data: [conta] } }, '/reserved-balances': { status: 500 } }));
  eq(escritas.filter((e) => e.tabela === 'of_caixinhas' && e.op === 'delete').length, 0, '§3 falha nas caixinhas NÃO apaga as que existem');
  ({ r, upd } = await rodar({ [`/consents/${ID}/accounts`]: { status: 200, corpo: { data: [conta] } } }));
  eq(escritas.filter((e) => e.tabela === 'of_caixinhas' && e.op === 'delete').length, 1, '§3 lista VAZIA respondida segue reconciliando');

  // ── §4 Repetição ─────────────────────────────────────────────────────────
  const fila = []; let relogio = 0; let rodou = 0; let cancelados = 0;
  const rep = criarRepetidor({
    sincronizar: async () => { rodou++; },
    agendar: (fn, ms) => { fila.push({ fn, ms }); return { id: fila.length }; },
    cancelar: () => { cancelados++; },
    agora: () => relogio,
  });
  eq(rep.falhou('a'), true, '§4 primeira falha agenda');
  eq(rep.falhou('a'), false, '§4 com repetição pendente não agenda outra');
  await fila[0].fn(); rep.falhou('a'); await fila[1].fn(); rep.falhou('a'); await fila[2].fn();
  eq(rep.falhou('a'), false, '§4 depois de 3 tentativas para');
  eq([fila.map((f) => f.ms / 60000), rodou], [[10, 30, 90], 3], '§4 10, 30 e 90 minutos');
  relogio += 4 * 3600 * 1000;
  eq(rep.falhou('a'), true, '§4 falha nova horas depois começa outra série');
  rep.deuCerto('a');
  eq(cancelados, 1, '§4 sucesso cancela a pendente');
  eq(rep.falhou('a'), true, '§4 e zera a contagem');
  eq(fila[fila.length - 1].ms, 600000, '§4 volta a 10 minutos');

  // ── §5 O texto do cliente ────────────────────────────────────────────────
  const cru = 'Celcoin GET /consents/01a2-1/credit-cards → 500 ';
  eq(erroDeSyncParaCliente(cru, 'error'), INSTAVEL, '§5 o texto do relato vira português');
  eq(erroDeSyncParaCliente('Celcoin GET /x → rede: timeout', 'updated'), INSTAVEL, '§5 rede');
  eq(erroDeSyncParaCliente('Celcoin GET /x → 403 CONSENT_INACTIVE', 'error'), OUTRO, '§5 recusa: genérico, sem técnica');
  eq(erroDeSyncParaCliente('duplicate key value violates unique constraint', 'error'), OUTRO, '§5 erro nosso não vai cru');
  eq(erroDeSyncParaCliente('Consentimento expirado. Conecte de novo.', 'expired'), 'Consentimento expirado. Conecte de novo.', '§5 frase pro cliente passa');
  eq(erroDeSyncParaCliente('Falha no login com o banco. Reconecte.', 'login_error'), 'Falha no login com o banco. Reconecte.', '§5 trilho antigo passa');
  eq(erroDeSyncParaCliente(null, 'updated'), null, '§5 sem erro');
  eq(/Celcoin|500|consents/.test(INSTAVEL + OUTRO), false, '§5 nada técnico nas frases');

  // ── §6 Renovar só o que dá pra ler ───────────────────────────────────────
  const p = providers.para('polp-celcoin');
  const ler = async (r1) => { zerar(); responder = () => r1; return providers.lerParaRenovar(p, ID); };
  eq(await ler({ status: 500 }), { ok: false, motivo: 'instavel' }, '§6 provedor fora → NÃO recriar');
  eq(await ler({ rede: true }), { ok: false, motivo: 'instavel' }, '§6 rede → NÃO recriar');
  eq(await ler({ status: 404 }), { ok: false, motivo: 'inexistente' }, '§6 404');
  eq(await ler({ status: 200, corpo: { data: { id: ID } } }), { ok: false, motivo: 'instavel' }, '§6 resposta sem status → NÃO recriar');
  eq((await ler(consent('AUTHORISED'))).viva, true, '§6 autorizado é vivo');
  const morto = await ler(consent('EXPIRED'));
  eq([morto.ok, morto.viva], [true, false], '§6 expirado pode ser recriado');

  // ── §7 As rotas reais ────────────────────────────────────────────────────
  const router = require('../src/routes/openFinance');
  const camada = router.stack.find((l) => l.route && l.route.path === '/conexoes/:externalId/reautorizar');
  const handler = camada.route.stack[camada.route.stack.length - 1].handle;
  const chamarRota = async (mapa) => {
    zerar();
    CONEXAO = { id: 'cx1', external_id: ID, grupo_id: 'g1', provider: 'polp-celcoin' };
    responder = mapa;
    let status = 200, corpo = null;
    const res = { status(s) { status = s; return this; }, json(j) { corpo = j; return this; } };
    await handler({ params: { externalId: ID }, grupoId: 'g1' }, res, () => {});
    return { status, corpo, recriou: vezes(`POST /consents/${ID}/recreate`) };
  };
  let x = await chamarRota(() => ({ status: 500 }));
  eq([x.status, x.recriou], [503, 0], '§7 "Autorizar" com o provedor fora: 503 e NADA recriado');
  x = await chamarRota(() => consent('AUTHORISED'));
  eq([x.corpo.jaAutorizada, x.recriou], [true, 0], '§7 autorizado: nada recriado');
  x = await chamarRota((m) => (m === 'POST' ? { status: 200, corpo: { data: { id: ID, status: 'AWAITING_AUTHORIZATION', url_to_authenticate: 'https://banco' } } } : consent('EXPIRED')));
  eq([x.corpo.renovada, x.recriou], [true, 1], '§7 expirado: recria, como antes');

  const fonte = require('fs').readFileSync(path.join(__dirname, '../src/routes/openFinance.js'), 'utf8');
  eq(/if \(morta && leitura\.ok && !leitura\.viva\) \{/.test(fonte), true, '§7 /conectar só recria o que o provedor confirma que não está autorizado');
  eq((fonte.match(/\.recriarConexao\(/g) || []).length, 2, '§7 só existem os 2 pontos que recriam, ambos cobertos');
  eq(/ultimo_erro: erroDeSyncParaCliente\(c\.ultimo_erro, c\.status\)/.test(fonte), true, '§7 a lista de conexões manda o texto do cliente');

  console.log(`${total} verificações · ${falhas.length ? `${falhas.length} FALHAS` : 'todas ok'}`);
  if (falhas.length) { for (const f of falhas) console.log('  ✘ ' + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
