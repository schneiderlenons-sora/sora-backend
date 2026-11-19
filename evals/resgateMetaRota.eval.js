// =============================================================================
// EVAL DE ROTA — POST /api/metas/:id/resgate, com e sem devolver pra uma conta.
//
// Pedido de cliente (nov/2026): ao resgatar R$ 500 de uma meta com R$ 5.000, o
// dinheiro devia voltar pra uma conta (saldo + entrada nas transações).
//
// O que não pode acontecer:
//   · a meta diminuir e o dinheiro não chegar na conta (falha no meio);
//   · o resgate virar "receita" do mês (tem de sair como transferência);
//   · mexer no saldo de conta do Open Finance (o banco manda no saldo);
//   · aceitar conta ou meta de OUTRO grupo, ou cartão de crédito como destino;
//   · resgate SEM conta mudar de comportamento (é o que todo mundo usa hoje).
//
// Roda a rota REAL e o `creditarConta` REAL sobre um banco falso.
// Rodar: npm run eval:resgate-meta
// =============================================================================
const Module = require('module');
const path = require('path');
const RAIZ = path.resolve(__dirname, '..');
process.env.SUPABASE_URL = 'http://falso';
process.env.SUPABASE_KEY = 'falso';

const falhas = [];
let casos = 0;
const ok = (c, m) => { casos++; if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

function bancoFalso(tabelas, cfg) {
  let seq = 0;
  const copia = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const from = (nome) => {
    const filtros = [];
    let modo = 'select', patch = null, novo = null;
    const linhas = () => (tabelas[nome] = tabelas[nome] || []).filter((r) => filtros.every(([c, v]) => r[c] === v));
    const executar = () => {
      if (modo === 'insert') {
        if (cfg.falhaInsert === nome) return { data: null, error: { message: 'falhou de propósito' } };
        const linha = { id: `${nome}-${++seq}`, ...novo };
        tabelas[nome].push(linha);
        return { data: linha, error: null };
      }
      if (modo === 'update') {
        if (cfg.falhaUpdate === nome) return { data: null, error: { message: 'falhou de propósito' } };
        const alvo = linhas();
        alvo.forEach((r) => Object.assign(r, patch));
        return { data: alvo[0] || null, error: null, todas: alvo };
      }
      if (modo === 'delete') {
        const fora = new Set(linhas());
        tabelas[nome] = tabelas[nome].filter((r) => !fora.has(r));
        return { data: null, error: null };
      }
      return { data: linhas()[0] || null, error: null, todas: linhas() };
    };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; }, in() { return q; },
      eq(c, v) { filtros.push([c, v]); return q; },
      insert(obj) { modo = 'insert'; novo = obj; tabelas[nome] = tabelas[nome] || []; return q; },
      update(p) { modo = 'update'; patch = p; return q; },
      delete() { modo = 'delete'; return q; },
      // ⚠️ Devolve CÓPIAS, como o Supabase de verdade: com a própria linha, a
      // "meta de antes" guardada pela rota mudaria junto com o update.
      maybeSingle() { const r = executar(); return Promise.resolve({ data: copia(r.data), error: r.error }); },
      single() { const r = executar(); return Promise.resolve({ data: copia(r.data), error: r.error }); },
      then(res, rej) { try { const r = executar(); return Promise.resolve(res({ data: copia(r.todas || r.data), error: r.error })); } catch (e) { return rej ? rej(e) : Promise.reject(e); } },
    };
    return q;
  };
  return { from };
}

function carregarRota(db, rota, metodo = 'post') {
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) return db;
    if (req.endsWith('middlewares/auth')) return (rq, rs, nx) => nx();
    if (req.endsWith('middlewares/permissao')) return { exigirPermissao: () => (rq, rs, nx) => nx() };
    return origLoad.call(this, req, parent, isMain);
  };
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  }
  const router = require(path.join(RAIZ, 'src/routes/metas.js'));
  Module._load = origLoad;
  const camada = router.stack.find((c) => c.route?.path === rota && c.route?.methods?.[metodo]);
  return camada.route.stack[camada.route.stack.length - 1].handle;
}

const META = (extra = {}) => ({ id: 'm1', grupo_id: 'g1', titulo: 'Viagem', valor_atual: 5000, valor_objetivo: 10000, status: 'ativo', ...extra });
const CONTAS = () => [
  { id: 'w1', grupo_id: 'g1', nome: 'Nubank', tipo: 'Corrente', saldo: 1000, of_conta_id: null },
  { id: 'w2', grupo_id: 'g1', nome: 'Itaú', tipo: 'Corrente', saldo: 2000, of_conta_id: 'of-123' },
  { id: 'w3', grupo_id: 'g1', nome: 'Cartão Nubank', tipo: 'Crédito', saldo: -300, of_conta_id: null },
  { id: 'w9', grupo_id: 'g2', nome: 'Conta de outro grupo', tipo: 'Corrente', saldo: 50, of_conta_id: null },
];

async function chamar({ rota = '/:id/resgate', meta = META(), wallets = CONTAS(), corpo, cfg = {} }) {
  const tabelas = { metas: [meta], wallets, meta_aportes: [], transacoes: [] };
  const h = carregarRota(bancoFalso(tabelas, cfg), rota);
  let status = 200, json = null;
  const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; } };
  await h({ params: { id: 'm1' }, body: corpo, grupoId: 'g1', userId: 'u1' }, res);
  const saldo = (id) => tabelas.wallets.find((w) => w.id === id)?.saldo;
  return { status, json, tabelas, meta: tabelas.metas[0], saldo };
}

(async () => {
  // 1. Sem conta: exatamente o comportamento de antes.
  let r = await chamar({ corpo: { valor: 500 } });
  eq(r.status, 200, '1. responde 200');
  eq(r.meta.valor_atual, 4500, '1. meta cai 500');
  eq(r.tabelas.meta_aportes.length, 1, '1. registra o resgate');
  eq(r.tabelas.meta_aportes[0].tipo, 'resgate', '1. o registro é de RESGATE');
  eq(r.tabelas.transacoes.length, 0, '1. sem conta, nenhuma transação');
  eq([r.saldo('w1'), r.saldo('w2')], [1000, 2000], '1. sem conta, nenhum saldo muda');
  eq(r.json.credito, null, '1. resposta diz que não creditou');

  // 2. Com conta manual: o dinheiro volta.
  r = await chamar({ corpo: { valor: 500, wallet_id: 'w1' } });
  eq(r.status, 200, '2. responde 200');
  eq(r.meta.valor_atual, 4500, '2. meta cai 500');
  eq(r.saldo('w1'), 1500, '2. saldo da conta sobe 500');
  eq(r.tabelas.transacoes.length, 1, '2. uma transação registrada');
  const tx = r.tabelas.transacoes[0] || {};
  eq(tx.tipo, 'Recebimento', '2. é uma ENTRADA');
  eq(tx.transferencia, true, '2. marcada como transferência (não é renda nova)');
  eq(tx.valor, 500, '2. valor certo');
  eq(tx.carteira_nome, 'Nubank', '2. na conta escolhida');
  eq(tx.grupo_id, 'g1', '2. no grupo certo');
  eq(tx.observacao, 'Resgate: Viagem', '2. descrição diz de qual meta veio');
  eq(tx.pago, true, '2. já recebida');
  eq(r.json.credito && r.json.credito.conta, { id: 'w1', nome: 'Nubank' }, '2. resposta diz pra qual conta foi');
  eq(r.saldo('w2'), 2000, '2. as outras contas ficam como estavam');

  // 3. Conta do Open Finance: registra a entrada, NÃO mexe no saldo (o banco manda).
  r = await chamar({ corpo: { valor: 500, wallet_id: 'w2' } });
  eq(r.status, 200, '3. responde 200');
  eq(r.saldo('w2'), 2000, '3. saldo de conta do banco intacto');
  eq(r.tabelas.transacoes.length, 1, '3. a entrada fica registrada');

  // 4. Conta de OUTRO grupo: 404 e nada muda.
  r = await chamar({ corpo: { valor: 500, wallet_id: 'w9' } });
  eq(r.status, 404, '4. conta de outro grupo: 404');
  eq(r.meta.valor_atual, 5000, '4. meta intacta');
  eq(r.tabelas.meta_aportes.length, 0, '4. nenhum resgate registrado');
  eq(r.saldo('w9'), 50, '4. conta do outro grupo intacta');
  eq(r.tabelas.transacoes.length, 0, '4. nenhuma transação');

  // 4B. Conta que não existe: 404 e nada muda.
  r = await chamar({ corpo: { valor: 500, wallet_id: 'nao-existe' } });
  eq([r.status, r.meta.valor_atual, r.tabelas.meta_aportes.length], [404, 5000, 0], '4B. conta inexistente: 404, nada muda');

  // 5. Cartão de crédito como destino: 400 e nada muda.
  r = await chamar({ corpo: { valor: 500, wallet_id: 'w3' } });
  eq(r.status, 400, '5. cartão não recebe resgate');
  eq([r.meta.valor_atual, r.saldo('w3'), r.tabelas.meta_aportes.length, r.tabelas.transacoes.length], [5000, -300, 0, 0], '5. nada muda');

  // 6. Mais do que tem na meta: 400 e nada muda.
  r = await chamar({ corpo: { valor: 5000.5, wallet_id: 'w1' } });
  eq(r.status, 400, '6. acima do guardado: 400');
  eq([r.meta.valor_atual, r.saldo('w1'), r.tabelas.transacoes.length], [5000, 1000, 0], '6. nada muda');

  // 7. Meta de OUTRO grupo: 404.
  r = await chamar({ meta: META({ grupo_id: 'g2' }), corpo: { valor: 500, wallet_id: 'w1' } });
  eq(r.status, 404, '7. meta de outro grupo: 404');
  eq([r.meta.valor_atual, r.saldo('w1'), r.tabelas.meta_aportes.length], [5000, 1000, 0], '7. nada muda');

  // 8. A entrada na conta FALHA: o resgate é desfeito (tudo ou nada).
  r = await chamar({ meta: META({ status: 'concluido', valor_atual: 12000 }), corpo: { valor: 3000, wallet_id: 'w1' }, cfg: { falhaInsert: 'transacoes' } });
  eq(r.status, 500, '8. falha na conta: 500');
  eq(r.meta.valor_atual, 12000, '8. meta volta ao valor de antes');
  eq(r.meta.status, 'concluido', '8. e ao status de antes');
  eq(r.tabelas.meta_aportes.length, 0, '8. o registro do resgate é apagado');
  eq(r.saldo('w1'), 1000, '8. saldo intacto');
  ok(/Nubank/.test(r.json && r.json.erro), '8. o erro diz qual conta e que nada foi feito');

  // 8B. A meta não atualiza: o registro do resgate não fica órfão.
  r = await chamar({ corpo: { valor: 500, wallet_id: 'w1' }, cfg: { falhaUpdate: 'metas' } });
  eq(r.status, 500, '8B. falha na meta: 500');
  eq([r.tabelas.meta_aportes.length, r.saldo('w1'), r.tabelas.transacoes.length], [0, 1000, 0], '8B. nada fica pela metade');

  // 9. Resgatar TUDO (o número da tela, com centavos).
  r = await chamar({ meta: META({ valor_atual: 100.3 }), corpo: { valor: 100.3, wallet_id: 'w1' } });
  eq(r.status, 200, '9. resgatar exatamente o guardado é permitido');
  eq(r.meta.valor_atual, 0, '9. meta fica em zero');
  eq(r.saldo('w1'), 1100.3, '9. conta recebe tudo');

  // 10. Meta concluída que perde parte: volta a "ativo".
  r = await chamar({ meta: META({ valor_atual: 10000, status: 'concluido' }), corpo: { valor: 500 } });
  eq(r.meta.status, 'ativo', '10. abaixo do objetivo volta a ativa');

  // 11. Valores inválidos: 400 e nada muda.
  for (const valor of [0, -50, 'abc', null]) {
    r = await chamar({ corpo: { valor, wallet_id: 'w1' } });
    eq([r.status, r.meta.valor_atual, r.saldo('w1')], [400, 5000, 1000], `11. valor ${JSON.stringify(valor)} recusado sem mexer em nada`);
  }

  // 12. O APORTE também deixou de aceitar meta de outro grupo.
  r = await chamar({ rota: '/:id/aporte', meta: META({ grupo_id: 'g2' }), corpo: { valor: 500 } });
  eq(r.status, 404, '12. aporte em meta de outro grupo: 404');
  eq(r.meta.valor_atual, 5000, '12. meta do outro grupo intacta');
  // …e segue funcionando no próprio grupo, debitando a conta como antes.
  r = await chamar({ rota: '/:id/aporte', corpo: { valor: 500, wallet_id: 'w1' } });
  eq([r.status, r.meta.valor_atual, r.saldo('w1')], [200, 5500, 500], '12. aporte no próprio grupo: meta sobe, conta desce');

  if (falhas.length) {
    console.log(`✗ ${falhas.length} de ${casos} falharam:\n - ` + falhas.join('\n - '));
    process.exit(1);
  }
  console.log(`✓ resgate de meta: ${casos} verificações ok`);
})();
