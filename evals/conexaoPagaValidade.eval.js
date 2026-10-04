// =============================================================================
// EVAL — a validade da conexão PAGA (migration 180) em `acessoOpenFinance`.
//
// Esta função decide quem tem Open Finance. O erro caro aqui não é deixar uma
// conexão expirada de pé: é TIRAR o acesso de quem está pagando — e o jeito
// mais fácil de fazer isso é um `select` com coluna que a migration ainda não
// criou, que devolve `data: null` e vira "pagas = 0" em silêncio.
//
// Caso real por trás: gilbertojun pagou R$ 60,00 por uma conexão ANUAL em
// 17/08/2026 (sem reembolso), o Stripe cancelou a assinatura por falha na
// cobrança de um upgrade, e `of_conexoes_pagas` foi a zero — prestes a cortar
// a conexão que ele pagou até 17/08/2027.
//
// Rodar: node evals/conexaoPagaValidade.eval.js
// =============================================================================
const Module = require('module');
const path = require('path');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

const AGORA = new Date('2026-10-04T12:00:00Z');

/**
 * @param user        linha de `users`
 * @param temColuna   false = migration 180 pendente (o select com a coluna erra)
 */
function carregar({ user, temColuna = true }) {
  const pedidos = [];
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) {
      return {
        from: () => {
          const q = {
            _cols: '',
            select(c) { q._cols = c; pedidos.push(c); return q; },
            eq() { return q; },
            maybeSingle() {
              const pediuNova = q._cols.includes('of_conexoes_pagas_ate');
              if (pediuNova && !temColuna) {
                return Promise.resolve({ data: null, error: { message: 'column users.of_conexoes_pagas_ate does not exist' } });
              }
              const saida = {};
              for (const c of q._cols.split(',').map((s) => s.trim())) {
                if (c in user) saida[c] = user[c];
              }
              return Promise.resolve({ data: saida, error: null });
            },
          };
          return q;
        },
      };
    }
    return origLoad.call(this, req, parent, isMain);
  };
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  }
  const mod = require(path.resolve(__dirname, '../src/config/openFinanceAccess'));
  Module._load = origLoad;
  return { acessoOpenFinance: mod.acessoOpenFinance, pedidos };
}

const U = (extra = {}) => ({
  email: 'cliente@x.com', phone: '5511999990000', plano: 'premium', vitalicio: true,
  of_conexoes_pagas: 0, of_conexoes_pagas_ate: null, ...extra,
});

(async () => {
  const RealDate = Date;
  global.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(AGORA); }
    static now() { return AGORA.getTime(); }
  };
  global.Date.UTC = RealDate.UTC; global.Date.parse = RealDate.parse;

  console.log('-- 1. conexao paga com prazo FUTURO continua valendo --');
  {
    // O caso do gilbertojun: pagou anual ate 17/08/2027.
    const { acessoOpenFinance } = carregar({
      user: U({ of_conexoes_pagas: 1, of_conexoes_pagas_ate: '2027-08-17T03:00:00Z' }),
    });
    const r = await acessoOpenFinance('u1');
    eq(r.pagas, 1, '§1 a conexão paga conta');
    eq(r.limite, 1, '§1 e vira limite (vitalício: franquia 0 + 1 paga)');
    eq(r.liberado, true, '§1 com acesso liberado');
  }
  console.log('  ok');

  console.log('-- 2. prazo VENCIDO expira a conexao --');
  {
    const { acessoOpenFinance } = carregar({
      user: U({ of_conexoes_pagas: 1, of_conexoes_pagas_ate: '2026-10-03T00:00:00Z' }),
    });
    const r = await acessoOpenFinance('u1');
    eq(r.pagas, 0, '§2 venceu ontem -> não conta mais');
    eq(r.limite, 0, '§2 e o limite cai a zero');
  }
  console.log('  ok');

  console.log('-- 3. NULL = SEM PRAZO (e e o que a base inteira tem) --');
  {
    // Assinatura mensal viva: quem a encerra e o webhook do Stripe, nao uma data.
    const { acessoOpenFinance } = carregar({ user: U({ of_conexoes_pagas: 2, of_conexoes_pagas_ate: null }) });
    const r = await acessoOpenFinance('u1');
    eq(r.pagas, 2, '§3 sem data, nada expira');
    eq(r.limite, 2, '§3 limite intacto');
  }
  console.log('  ok');

  console.log('-- 4. MIGRATION 180 PENDENTE: quem paga NAO perde acesso --');
  {
    // O erro caro. Sem o refaz, o select errado devolve data:null e zera `pagas`.
    const { acessoOpenFinance, pedidos } = carregar({
      user: U({ of_conexoes_pagas: 3 }), temColuna: false,
    });
    const r = await acessoOpenFinance('u1');
    eq(r.pagas, 3, '§4 SEM A MIGRATION, as conexoes pagas CONTINUAM contando');
    eq(r.limite, 3, '§4 e o limite se mantem');
    eq(pedidos.some((p) => p.includes('of_conexoes_pagas_ate')), true, '§4 tentou a coluna nova');
    eq(pedidos.some((p) => p === 'of_conexoes_pagas'), true, '§4 e REFEZ sem ela');
  }
  console.log('  ok');

  console.log('-- 5. data ILEGIVEL nao expira (na duvida, mantem o que foi pago) --');
  {
    for (const lixo of ['ontem', '', 'null', '0000-00-00']) {
      const { acessoOpenFinance } = carregar({
        user: U({ of_conexoes_pagas: 1, of_conexoes_pagas_ate: lixo }),
      });
      const r = await acessoOpenFinance('u1');
      eq(r.pagas, 1, `§5 '${lixo}' NAO expira a conexao paga`);
    }
  }
  console.log('  ok');

  console.log('-- 6. assinante comum: franquia do plano + as pagas --');
  {
    const { acessoOpenFinance } = carregar({
      user: U({ plano: 'basico', vitalicio: false, of_conexoes_pagas: 2, of_conexoes_pagas_ate: '2027-01-01T00:00:00Z' }),
    });
    const r = await acessoOpenFinance('u1');
    eq(r.franquia, 1, '§6 Basico da 1 de franquia');
    eq(r.limite, 3, '§6 + 2 pagas = 3');
  }
  {
    // E com as pagas VENCIDAS ele volta a so ter a franquia — nunca perde ela.
    const { acessoOpenFinance } = carregar({
      user: U({ plano: 'basico', vitalicio: false, of_conexoes_pagas: 2, of_conexoes_pagas_ate: '2026-01-01T00:00:00Z' }),
    });
    const r = await acessoOpenFinance('u1');
    eq(r.limite, 1, '§6 vencidas -> sobra a franquia do plano');
    eq(r.liberado, true, '§6 e ele NAO perde o Open Finance');
  }
  console.log('  ok');

  global.Date = RealDate;
  console.log('');
  if (falhas.length) {
    console.error(`x ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('OK conexaoPagaValidade: expira o prazo vencido sem nunca cortar quem paga');
  process.exit(0);
})().catch((e) => { console.error('x erro:', e.message); process.exit(1); });
