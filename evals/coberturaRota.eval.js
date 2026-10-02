// =============================================================================
// EVAL DE ROTA — o GET /api/openfinance/conexoes diz a verdade sobre a cobertura?
//
// O risco desta tela nao e deixar de avisar: e AVISAR QUEM ESTA EM DIA. Um
// "sua conexao sera desligada" indevido faz o cliente desconectar o banco por
// nada — e reconectar cria consentimento novo, que a Polp cobra.
//
// Por isso tres dos cinco casos aqui sao sobre NAO avisar: dentro do direito,
// conexao de OUTRO membro do grupo, e limite que nao deu pra ler.
//
// Rodar: node evals/coberturaRota.eval.js
// =============================================================================
const Module = require('module');
const path = require('path');
const RAIZ = path.resolve(__dirname, '..');
process.env.SUPABASE_URL = 'http://falso';
process.env.SUPABASE_KEY = 'falso';

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

function rodar({ conexoes, limite, marco = null, erroUsers = false }) {
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) {
      return {
        from: (nome) => {
          const q = {
            select() { return q; }, eq() { return q; }, or() { return q; },
            in() { return q; }, order() { return q; },
            maybeSingle: () => Promise.resolve(nome === 'users'
              ? (erroUsers ? { data: null, error: { message: 'x' } } : { data: { of_excedente_desde: marco }, error: null })
              : { data: null, error: null }),
            then(res) {
              if (nome === 'of_conexoes') return res({ data: conexoes, error: null });
              return res({ data: [], error: null });
            },
          };
          return q;
        },
      };
    }
    if (req.endsWith('config/openFinanceAccess')) {
      return {
        acessoOpenFinance: async () => ({ liberado: true, limite }),
        liberadoOpenFinance: async () => true, LIMITE_CONEXOES: {},
      };
    }
    if (req.endsWith('middlewares/auth')) return (rq, rs, nx) => nx();
    if (req.endsWith('middlewares/permissao')) return { exigirPermissao: () => (rq, rs, nx) => nx() };
    return origLoad.call(this, req, parent, isMain);
  };
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  }
  const router = require(path.join(RAIZ, 'src/routes/openFinance.js'));
  Module._load = origLoad;

  const camada = router.stack.find((c) => c.route?.path === '/conexoes' && c.route?.methods?.get);
  if (!camada) throw new Error('GET /conexoes nao achada');
  const h = camada.route.stack[camada.route.stack.length - 1].handle;
  let corpo = null;
  const res = { status() { return res; }, json(j) { corpo = j; return res; } };
  return h({ authUser: { id: 'u1', grupoAtivo: 'g1' } }, res).then(() => corpo);
}

const CX = (id, extra = {}) => ({
  external_id: id, user_id: 'u1', grupo_id: 'g1', provider: 'polp-celcoin',
  instituicao: 'Banco ' + id, status: 'updated',
  ultima_sync: '2026-10-02T00:00:00Z', created_at: '2026-01-0' + (extra.d || 1) + 'T00:00:00Z',
  ...extra,
});

(async () => {
  // 1. dentro do direito → sem aviso
  let r = await rodar({ conexoes: [CX('a')], limite: 3 });
  eq(r.cobertura, null, '1. dentro do direito nao manda cobertura');

  // 2. excede → avisa, nomeando qual sairia
  r = await rodar({ conexoes: [CX('a', { d: 1 }), CX('b', { d: 9 })], limite: 1 });
  eq(r.cobertura?.estado, 'avisando', '2. avisando');
  eq(r.cobertura?.excedente, 1, '2. uma excedente');
  eq(r.cobertura?.aDesligar.join(','), 'Banco b', '2. e diz QUAL sairia (a mais nova)');

  // 3. conexao de OUTRO membro do grupo nao conta contra a franquia da pessoa
  r = await rodar({ conexoes: [CX('a'), CX('z', { user_id: 'outro' })], limite: 1 });
  eq(r.cobertura, null, '3. conexao de outro membro NAO acusa excedente');

  // 4. migration 179 pendente: ainda avisa (so sem prazo gravado), nunca quebra
  r = await rodar({ conexoes: [CX('a')], limite: 0, erroUsers: true });
  eq(r.cobertura?.estado, 'avisando', '4. sem a 179 ainda avisa');

  // 5. limite nao lido → nada afirmado
  r = await rodar({ conexoes: [CX('a')], limite: null });
  eq(r.cobertura, null, '5. limite nao lido NAO acusa excedente');

  if (falhas.length) { console.error('x falhas:'); falhas.forEach((f) => console.error(' ·', f)); process.exit(1); }
  console.log('OK rota /conexoes: cobertura sai certa');
  process.exit(0);
})().catch((e) => { console.error('x', e.message); process.exit(1); });
