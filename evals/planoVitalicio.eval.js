// =============================================================================
// EVAL: middlewares/plano.js — vitalício NUNCA expira pelo `plano_valido_ate`.
// Rodar: npm run eval:plano-vitalicio
//
// Caso real (nov/2026): o sync do Stripe regravou num vitalício a validade de
// uma assinatura ANTIGA (de antes do vitalício). Quando a data passou, o
// `exigirPlano` o deixou `inativo` — o cliente pagava o vitalício e a
// mensalidade, sem acesso. O sync foi corrigido no frontend; isto é a rede.
// =============================================================================
const Module = require('module');
const fs = require('fs');
const path = require('path');

const falhas = [];
let casos = 0;
const ok = (cond, msg) => { casos++; if (!cond) falhas.push(msg); };

const ONTEM = new Date(Date.now() - 864e5).toISOString();
const AMANHA = new Date(Date.now() + 864e5).toISOString();

/** Roda o exigirPlano com uma linha de usuário falsa. */
async function rodar({ linha, permitidos = ['premium', 'platinum'], jaLida = false }) {
  const updates = [];
  const selects = [];
  const fake = () => {
    const q = {
      select(cols) { selects.push(cols); return q; },
      eq() { return q; },
      maybeSingle: async () => ({ data: linha, error: null }),
      update(patch) { updates.push(patch); return { eq: () => ({ then: (f) => { f(); return { catch: () => {} }; } }) }; },
    };
    return q;
  };
  const origLoad = Module._load;
  let exigirPlano;
  try {
    for (const k of Object.keys(require.cache)) if (/sora-backend[\\/]src[\\/]/.test(k)) delete require.cache[k];
    Module._load = function (req, parent, isMain) {
      if (req.endsWith('db/supabase')) return { from: fake };
      return origLoad.apply(this, arguments);
    };
    ({ exigirPlano } = require('../src/middlewares/plano'));
  } finally { Module._load = origLoad; }

  const req = { params: {}, query: {}, authUser: { id: linha?.id || 'u1', row: jaLida ? linha : null } };
  let status = 200; let passou = false;
  const res = { status(s) { status = s; return { json: () => {} }; } };
  await exigirPlano(...permitidos)(req, res, () => { passou = true; });
  await new Promise((r) => setTimeout(r, 5));
  return { passou, status, updates, selects };
}

(async () => {
  // ── 1. O caso real: vitalício com validade vencida gravada por engano.
  let r = await rodar({ linha: { id: 'u1', plano: 'premium', plano_valido_ate: ONTEM, vitalicio: true } });
  ok(r.passou, '1. vitalício com validade vencida continua com acesso');
  ok(!r.updates.some((u) => u.plano === 'inativo'), '1. e NÃO é gravado como inativo');

  // Pela linha que o `auth` já leu (o caminho normal das rotas com JWT).
  r = await rodar({ linha: { id: 'u1', plano: 'premium', plano_valido_ate: ONTEM, vitalicio: true }, jaLida: true });
  ok(r.passou && !r.updates.length, '1. idem pela linha do auth');

  // ── 2. Assinante comum: a expiração continua exatamente como antes.
  r = await rodar({ linha: { id: 'u1', plano: 'premium', plano_valido_ate: ONTEM, vitalicio: false } });
  ok(!r.passou && r.status === 403, '2. assinatura vencida perde o acesso');
  ok(r.updates.some((u) => u.plano === 'inativo'), '2. e é gravada como inativo');
  r = await rodar({ linha: { id: 'u1', plano: 'premium', plano_valido_ate: ONTEM } });
  ok(!r.passou, '2. sem a coluna vitalicio (null) = assinante comum');
  r = await rodar({ linha: { id: 'u1', plano: 'premium', plano_valido_ate: AMANHA, vitalicio: false } });
  ok(r.passou && !r.updates.length, '2. assinatura em dia segue com acesso');

  // ── 3. O vitalício não ganha nada além do próprio plano.
  r = await rodar({ linha: { id: 'u1', plano: 'kit', plano_valido_ate: null, vitalicio: true } });
  ok(!r.passou && r.status === 403, '3. Kit vitalício não entra em rota de Premium');
  r = await rodar({ linha: { id: 'u1', plano: 'inativo', plano_valido_ate: ONTEM, vitalicio: true } });
  ok(!r.passou, '3. vitalício gravado como inativo segue sem acesso (o conserto é no dado)');

  // ── 4. A coluna é pedida nas duas leituras (auth e exigirPlano).
  r = await rodar({ linha: { id: 'u1', plano: 'premium', plano_valido_ate: null, vitalicio: true } });
  ok(r.selects.some((c) => /\bvitalicio\b/.test(c)), '4. exigirPlano pede a coluna vitalicio');
  const auth = fs.readFileSync(path.join(__dirname, '../src/middlewares/auth.js'), 'utf8');
  ok(/\.select\('id, phone, grupo_ativo, plano, plano_valido_ate, vitalicio'\)/.test(auth), '4. auth pede a coluna vitalicio na linha que o exigirPlano reaproveita');

  if (falhas.length) {
    console.error(`\n❌ ${falhas.length} de ${casos} falharam:`);
    for (const f of falhas) console.error('  ·', f);
    process.exit(1);
  }
  console.log(`✅ plano × vitalício: ${casos} verificações ok`);
})();
