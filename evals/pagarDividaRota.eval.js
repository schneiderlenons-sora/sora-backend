// =============================================================================
// EVAL DE ROTA — POST /api/dividas/:id/pagar, com e sem débito do extrato.
//
// O que não pode acontecer:
//   · debitar a conta quando a parcela foi paga por um débito que JÁ está no
//     extrato (o dinheiro sairia duas vezes);
//   · mexer na contagem de parcelas de dívida do Open Finance (o banco a
//     reescreve; o "53/120" pularia e voltaria sozinho);
//   · aceitar dívida ou lançamento de OUTRO grupo;
//   · responder 200 com o pagamento não gravado.
//
// Rodar: npm run eval:pagar-divida-rota
// =============================================================================
const Module = require('module');
const path = require('path');
const RAIZ = path.resolve(__dirname, '..');
process.env.SUPABASE_URL = 'http://falso';
process.env.SUPABASE_KEY = 'falso';

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

function bancoFalso(tabelas, cfg) {
  const log = { inserts: [], updates: [] };
  const casa = (row, filtros) => filtros.every(([op, c, v]) => (op === 'eq' ? row[c] === v : op === 'neq' ? row[c] !== v : true));
  const from = (nome) => {
    const filtros = [];
    let modo = 'select', patch = null;
    const linhas = () => (tabelas[nome] || []).filter((r) => casa(r, filtros));
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; }, in() { return q; }, not() { return q; },
      eq(c, v) { filtros.push(['eq', c, v]); return q; },
      neq(c, v) { filtros.push(['neq', c, v]); return q; },
      update(p) { modo = 'update'; patch = p; return q; },
      insert(obj) {
        if (cfg.erroInsert) return Promise.resolve({ error: { message: 'falhou' } });
        if (cfg.semColuna && 'transacao_id' in obj) return Promise.resolve({ error: { message: 'column "transacao_id" does not exist' } });
        log.inserts.push({ tabela: nome, obj });
        (tabelas[nome] = tabelas[nome] || []).push(obj);
        return Promise.resolve({ error: null });
      },
      maybeSingle() { return Promise.resolve({ data: linhas()[0] || null, error: null }); },
      single() {
        if (modo === 'update') {
          const r = linhas()[0];
          if (r) Object.assign(r, patch);
          log.updates.push({ tabela: nome, patch });
          return Promise.resolve({ data: r || null, error: null });
        }
        return Promise.resolve({ data: linhas()[0] || null, error: null });
      },
      then(res) { return res({ data: linhas(), error: null }); },
    };
    return q;
  };
  return { db: { from }, log };
}

async function pagar({ divida, transacoes = [], pagamentos = [], corpo, cfg = {} }) {
  const tabelas = { dividas: [divida], transacoes, divida_pagamentos: pagamentos };
  const { db, log } = bancoFalso(tabelas, cfg);
  const debitos = [];
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) return db;
    if (req.endsWith('services/contaDebito')) return { debitarConta: async (a) => { debitos.push(a); return { ok: true }; } };
    if (req.endsWith('middlewares/auth')) return (rq, rs, nx) => nx();
    if (req.endsWith('middlewares/permissao')) return { exigirPermissao: () => (rq, rs, nx) => nx() };
    return origLoad.call(this, req, parent, isMain);
  };
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  }
  const router = require(path.join(RAIZ, 'src/routes/dividas.js'));
  Module._load = origLoad;
  const camada = router.stack.find((c) => c.route?.path === '/:id/pagar' && c.route?.methods?.post);
  const h = camada.route.stack[camada.route.stack.length - 1].handle;
  let status = 200, json = null;
  const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; } };
  await h({ params: { id: divida.id }, body: corpo, grupoId: 'g1', userId: 'u1' }, res);
  return { status, json, log, debitos, tabelas };
}

const DIV = (extra = {}) => ({ id: 'd1', grupo_id: 'g1', titulo: 'Empréstimo', valor_parcela: 720.34,
  parcelas_total: 120, parcelas_pagas: 53, dia_vencimento: 20, status: 'ativa', of_id: null, ...extra });
const TX = (extra = {}) => ({ id: 't1', grupo_id: 'g1', tipo: 'Gasto', valor: 727.12, data: '2026-10-20',
  observacao: 'PGTO CDC RENOV', carteira_nome: 'Banco do Brasil', ...extra });

(async () => {
  // 1. Pago com débito do extrato: NÃO debita, mesmo com conta escolhida, e grava o vínculo.
  let r = await pagar({ divida: DIV(), transacoes: [TX()],
    corpo: { valor: 727.12, data_pagamento: '2026-10-20', transacao_id: 't1', wallet_id: 'w1' } });
  eq(r.status, 200, '1. responde 200');
  eq(r.debitos.length, 0, '1. NÃO debita a conta de novo');
  eq(r.log.inserts[0] && r.log.inserts[0].obj.transacao_id, 't1', '1. grava o vínculo com o débito');
  eq(r.tabelas.dividas[0].parcelas_pagas, 54, '1. dívida manual: conta a parcela');

  // 2. Sem débito do extrato, com conta escolhida: debita como sempre.
  r = await pagar({ divida: DIV(), corpo: { valor: 720.34, wallet_id: 'w1' } });
  eq(r.debitos.length, 1, '2. pagamento comum segue debitando a conta escolhida');
  ok(!('transacao_id' in (r.log.inserts[0] || { obj: {} }).obj), '2. sem vínculo quando não há débito');

  // 3. Dívida do Open Finance: registra o pagamento, NÃO mexe na contagem.
  r = await pagar({ divida: DIV({ of_id: 'of-1', origem: 'of' }), transacoes: [TX()],
    corpo: { valor: 727.12, transacao_id: 't1' } });
  eq(r.status, 200, '3. responde 200');
  eq(r.log.inserts.length, 1, '3. registra o pagamento');
  eq(r.log.updates.filter((u) => u.tabela === 'dividas').length, 0, '3. NÃO atualiza a dívida do banco');
  eq(r.tabelas.dividas[0].parcelas_pagas, 53, '3. contagem do banco intacta');
  eq(r.json.quitada, false, '3. nunca diz "quitada" numa dívida do banco');

  // 3A. Na ÚLTIMA parcela pela conta da Sora: ainda assim quem diz "quitada" é o banco.
  r = await pagar({ divida: DIV({ of_id: 'of-1', parcelas_pagas: 119 }), corpo: { valor: 720.34 } });
  eq(r.json.quitada, false, '3A. última parcela de dívida do banco não vira "quitada" por conta própria');

  // 3B. Dívida do Open Finance paga descontando de uma conta: o débito continua.
  r = await pagar({ divida: DIV({ of_id: 'of-1' }), corpo: { valor: 720.34, wallet_id: 'w1' } });
  eq(r.debitos.length, 1, '3B. dívida do banco paga por conta escolhida ainda debita');

  // 4. Lançamento de OUTRO grupo: recusa, nada é gravado.
  r = await pagar({ divida: DIV(), transacoes: [TX({ grupo_id: 'g2' })], corpo: { valor: 727.12, transacao_id: 't1' } });
  eq(r.status, 404, '4. débito de outro grupo: 404');
  eq(r.log.inserts.length, 0, '4. nada gravado');

  // 4B. Lançamento que é ENTRADA, não débito: recusa.
  r = await pagar({ divida: DIV(), transacoes: [TX({ tipo: 'Recebimento' })], corpo: { valor: 727.12, transacao_id: 't1' } });
  eq(r.status, 404, '4B. entrada de dinheiro não paga parcela');

  // 5. Dívida de OUTRO grupo: recusa.
  r = await pagar({ divida: DIV({ grupo_id: 'g2' }), corpo: { valor: 10 } });
  eq(r.status, 404, '5. dívida de outro grupo: 404');
  eq(r.log.inserts.length, 0, '5. nada gravado');

  // 6. O mesmo débito na MESMA dívida duas vezes: 409.
  r = await pagar({ divida: DIV(), transacoes: [TX()], pagamentos: [{ divida_id: 'd1', transacao_id: 't1' }],
    corpo: { valor: 727.12, transacao_id: 't1' } });
  eq(r.status, 409, '6. débito repetido na mesma dívida: 409');

  // 6B. O mesmo débito em OUTRA dívida: pode (um débito único paga vários empréstimos).
  r = await pagar({ divida: DIV(), transacoes: [TX()], pagamentos: [{ divida_id: 'outra', transacao_id: 't1' }],
    corpo: { valor: 435.04, transacao_id: 't1' } });
  eq(r.status, 200, '6B. mesmo débito em outra dívida é aceito');

  // 7. Insert falhou: 500, e a parcela NÃO é contada.
  r = await pagar({ divida: DIV(), corpo: { valor: 720.34 }, cfg: { erroInsert: true } });
  eq(r.status, 500, '7. erro ao gravar vira 500');
  eq(r.log.updates.length, 0, '7. nada de contar parcela sem pagamento gravado');

  // 8. Migration 190 pendente: grava sem o vínculo, avisa, e não debita.
  r = await pagar({ divida: DIV(), transacoes: [TX()], corpo: { valor: 727.12, transacao_id: 't1', wallet_id: 'w1' },
    cfg: { semColuna: true } });
  eq(r.status, 200, '8. sem a 190 ainda registra');
  eq(r.json.semVinculo, true, '8. e avisa que ficou sem vínculo');
  eq(r.debitos.length, 0, '8. e continua sem debitar');

  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ pagar parcela (rota): todos os casos passaram');
})().catch((e) => { console.error('✗ eval quebrou:', e); process.exit(1); });
