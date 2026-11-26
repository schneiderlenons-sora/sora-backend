// =============================================================================
// EVAL — chave do widget (services/widgetChave.js) e quem pode usar
// (config/widgets.js). Banco falso: nada sai daqui.
//
// Trava:
//   1. o código e a chave NUNCA são guardados em texto (só sha256);
//   2. código de USO ÚNICO: a 2ª troca falha (inclusive em paralelo);
//   3. código vencido (5 min) e formato torto são recusados;
//   4. chave com formato torto nem chega ao banco;
//   5. desconectar só funciona pro DONO da conexão;
//   6. acesso: só assinante (mensal/anual, Stripe/Play/Apple); vitalício, Kit,
//      grátis, vencido ficam de fora; lista de teste entra sempre; teste
//      fechado por padrão; interruptor geral.
//
// Rodar: npm run eval:widget-chave
// =============================================================================
process.env.WIDGETS_ATIVOS = '';
process.env.WIDGETS_ABERTOS = '0';
const chave = require('../src/services/widgetChave');
const { acessoWidget } = require('../src/config/widgets');

let falhas = 0; let ok = 0;
const certo = (cond, msg) => { if (cond) ok++; else { falhas++; console.log('  ✗', msg); } };

// ── banco falso (só o que o serviço usa) ────────────────────────────────────
function bancoFalso() {
  const tabelas = { widget_codigos: [], widget_conexoes: [] };
  let rpcChamadas = 0;
  const db = {
    tabelas,
    get rpcChamadas() { return rpcChamadas; },
    rpc: async (nome, args) => {
      rpcChamadas++;
      const c = tabelas.widget_conexoes.find((x) => x.token_hash === args.p_hash && !x.revogado_em);
      return { data: c ? { user_id: c.user_id, grupo_id: 'g1', versao: 1 } : null, error: null };
    },
    from: (t) => {
      const filtros = []; let op = null; let valores = null; let selecionar = false;
      const q = {
        insert: async (row) => { tabelas[t].push({ ...row }); return { error: null }; },
        update: (v) => { op = 'update'; valores = v; return q; },
        select: () => { selecionar = true; if (!op) op = 'select'; return q; },
        eq: (c, v) => { filtros.push((r) => r[c] === v); return q; },
        is: (c, v) => { filtros.push((r) => (r[c] ?? null) === v); return q; },
        order: () => q,
        maybeSingle: async () => {
          const achados = tabelas[t].filter((r) => filtros.every((f) => f(r)));
          if (op === 'update') {
            const alvo = achados[0];
            if (!alvo) return { data: null, error: null };
            Object.assign(alvo, valores);
            return { data: { ...alvo }, error: null };
          }
          return { data: achados[0] ? { ...achados[0] } : null, error: null };
        },
        then: (resolve) => resolve({ data: tabelas[t].filter((r) => filtros.every((f) => f(r))), error: null }),
      };
      return q;
    },
  };
  return db;
}

(async () => {
  console.log('── 1–3. código → chave ──');
  {
    const db = bancoFalso();
    const agora = Date.parse('2026-11-25T12:00:00Z');
    const { codigo } = await chave.criarCodigo(db, 'u1', { agora });
    certo(chave.FORMATO_CODIGO.test(codigo), 'código no formato');
    certo(!JSON.stringify(db.tabelas).includes(codigo), '⚠️ código NÃO fica em texto no banco');

    const [a, b] = await Promise.all([
      chave.trocarCodigo(db, { codigo, plataforma: 'ios', aparelho: 'iPhone' }, { agora: agora + 1000 }),
      chave.trocarCodigo(db, { codigo, plataforma: 'ios', aparelho: 'iPhone' }, { agora: agora + 1000 }),
    ]);
    const chaves = [a, b].filter((x) => x.chave);
    certo(chaves.length === 1, '⚠️ dois pedidos com o mesmo código geram UMA chave');
    certo([a, b].some((x) => x.erro === 'codigo_invalido'), 'o 2º pedido é recusado');
    const k = chaves[0].chave;
    certo(chave.FORMATO_CHAVE.test(k), 'chave no formato');
    certo(!JSON.stringify(db.tabelas).includes(k), '⚠️ chave NÃO fica em texto no banco');
    certo(db.tabelas.widget_conexoes[0].token_hash === chave.hash(k), 'guarda o sha256 da chave');

    const deNovo = await chave.trocarCodigo(db, { codigo, plataforma: 'ios' }, { agora: agora + 2000 });
    certo(deNovo.erro === 'codigo_invalido', 'código usado não serve de novo');

    const v = await chave.criarCodigo(db, 'u1', { agora });
    const venc = await chave.trocarCodigo(db, { codigo: v.codigo, plataforma: 'android' }, { agora: agora + 6 * 60 * 1000 });
    certo(venc.erro === 'codigo_expirado', 'código com mais de 5 min é recusado');
    certo(db.tabelas.widget_conexoes.length === 1, 'código vencido não cria chave');

    certo((await chave.trocarCodigo(db, { codigo: 'abc', plataforma: 'ios' })).erro === 'codigo_invalido', 'formato torto recusado');
    certo((await chave.trocarCodigo(db, { codigo: v.codigo, plataforma: 'windows' })).erro === 'plataforma', 'plataforma desconhecida recusada');
  }
  console.log('── 4–5. contexto e desconectar ──');
  {
    const db = bancoFalso();
    const { codigo } = await chave.criarCodigo(db, 'dono');
    const { chave: k } = await chave.trocarCodigo(db, { codigo, plataforma: 'ios' });
    certo((await chave.contexto(db, k)).user_id === 'dono', 'chave válida devolve o contexto');
    const antes = db.rpcChamadas;
    certo((await chave.contexto(db, 'Bearer lixo')) === null, 'chave torta → null');
    certo(db.rpcChamadas === antes, '⚠️ chave torta nem chega ao banco');
    const id = db.tabelas.widget_conexoes[0].id || (db.tabelas.widget_conexoes[0].id = 'c1');
    certo((await chave.revogar(db, { conexaoId: id, userId: 'outra-pessoa' })) === false, '⚠️ outra conta NÃO desconecta o aparelho');
    certo((await chave.contexto(db, k)) !== null, 'a chave segue valendo depois da tentativa alheia');
    certo((await chave.revogar(db, { conexaoId: id, userId: 'dono' })) === true, 'o dono desconecta');
    certo((await chave.contexto(db, k)) === null, 'chave revogada não vale mais');
  }

  console.log('── 6. quem pode usar ──');
  {
    const assinante = { email: 'a@x.com', plano: 'premium', assinatura_stripe: true };
    certo(acessoWidget(assinante).motivo === 'teste', 'WIDGETS_ABERTOS=0 volta ao teste fechado');
    for (const e of ['schneider.lenon.s@gmail.com', 'COMERCIALSORA@gmail.com']) {
      certo(acessoWidget({ email: e, plano: 'premium', vitalicio: true }).ok, `lista de teste entra com qualquer plano (${e})`);
    }
    process.env.WIDGETS_ABERTOS = '';
    certo(acessoWidget(assinante).ok, 'ABERTO por padrão (sem a variável): premium com assinatura do Stripe entra');
    certo(acessoWidget({ ...assinante, plano: 'basico' }).ok, 'básico com assinatura entra');
    certo(acessoWidget({ ...assinante, plano: 'platinum' }).ok, 'platinum entra');
    certo(acessoWidget({ ...assinante, plano: 'black' }).ok, 'black (= premium) entra');
    certo(acessoWidget({ email: 'b@x.com', plano: 'premium', plano_fonte: 'play' }).ok, 'assinante da Play entra');
    certo(acessoWidget({ email: 'b@x.com', plano: 'premium', plano_fonte: 'apple' }).ok, 'assinante da Apple entra');
    certo(acessoWidget({ ...assinante, vitalicio: true }).motivo === 'plano', '⚠️ vitalício da Completa (plano premium) fica de fora');
    certo(acessoWidget({ email: 'c@x.com', plano: 'premium' }).motivo === 'plano', 'premium SEM assinatura fica de fora');
    for (const p of ['kit', 'gratis', 'inativo', 'qualquer']) {
      certo(acessoWidget({ ...assinante, plano: p }).motivo === 'plano', `${p} fica de fora`);
    }
    certo(acessoWidget({ ...assinante, plano_valido_ate: '2026-01-01' }, new Date('2026-11-25')).motivo === 'plano', 'plano vencido fica de fora');
    certo(acessoWidget(null).motivo === 'plano', 'sem conta fica de fora');
    process.env.WIDGETS_ATIVOS = '0';
    certo(acessoWidget({ email: 'comercialsora@gmail.com' }).motivo === 'desligado', 'interruptor geral desliga até a lista de teste');
    process.env.WIDGETS_ATIVOS = '';
    process.env.WIDGETS_ABERTOS = '0';
  }

  console.log(`\n${ok} verificações · ${falhas ? `${falhas} FALHAS` : 'todas ok'}`);
  if (falhas) process.exit(1);
})();
