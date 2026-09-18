// =============================================================================
// eval:saldo-conta-banco — pelo WhatsApp, conta do Open Finance NÃO tem saldo
// mexido à mão (a regra de ouro), e a resposta EXPLICA por quê.
//
// POR QUE EXISTE (set/2026). Um cliente mandou vídeo: "a Sora não sincroniza"
// — lançava e o saldo da conta não mudava. A conta era do Open Finance e o
// painel estava CERTO em não mexer. Só que o WhatsApp mexia, em 5 arquivos sem
// trava nenhuma: o mesmo lançamento andava o saldo por um canal e não pelo
// outro, e o do zap ainda voltava sozinho no sync seguinte.
//
// Hoje tudo passa por `services/saldoCarteira.js`. Cada caso aqui tem o par:
// conta do banco (não mexe) × conta manual (mexe como sempre) — sem o segundo,
// um "consertar" que parasse de mexer em TUDO passaria.
//
// Rodar: node evals/saldoContaBanco.eval.js
// =============================================================================
const path = require('path');

const falhas = [];
const ok = (c, msg) => { if (!c) falhas.push(msg); };

function criarBanco(inicial) {
  const tabelas = JSON.parse(JSON.stringify(inicial));
  let seq = 0;
  function from(nome) {
    const filtros = [];
    let modo = 'select', payload = null, unica = null;
    const api = {
      select() { return api; },
      insert(p) { modo = 'insert'; payload = p; return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      upsert(p) { modo = 'upsert'; payload = p; return api; },
      delete() { modo = 'delete'; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      ilike(c, v) { filtros.push((r) => String(r[c] ?? '').toLowerCase() === String(v ?? '').toLowerCase()); return api; },
      in(c, arr) { const s = new Set(arr); filtros.push((r) => s.has(r[c])); return api; },
      gte() { return api; }, lte() { return api; }, order() { return api; }, limit() { return api; },
      is() { return api; }, not() { return api; }, or() { return api; }, neq() { return api; },
      single() { unica = 'single'; return api; }, maybeSingle() { unica = 'maybe'; return api; },
      then(res, rej) { return Promise.resolve().then(executar).then(res, rej); },
    };
    function executar() {
      const t = tabelas[nome] || (tabelas[nome] = []);
      // upsert de carteira casa por (grupo_id, nome), como o onConflict real.
      if (modo === 'upsert' && nome === 'wallets') {
        const p = Array.isArray(payload) ? payload[0] : payload;
        const ja = t.find((r) => r.grupo_id === p.grupo_id && r.nome === p.nome);
        if (ja) { Object.assign(ja, p); return { data: unica ? { ...ja } : [{ ...ja }], error: null }; }
      }
      if (modo === 'insert' || modo === 'upsert') {
        const novas = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: `${nome}-${++seq}`, ...p }));
        t.push(...novas);
        return { data: unica ? novas[0] : novas, error: null };
      }
      const alvo = t.filter((r) => filtros.every((f) => f(r)));
      if (modo === 'update') { alvo.forEach((r) => Object.assign(r, payload)); return { data: null, error: null }; }
      if (modo === 'delete') { tabelas[nome] = t.filter((r) => !alvo.includes(r)); return { data: null, error: null }; }
      if (unica === 'single') return alvo.length === 1 ? { data: { ...alvo[0] }, error: null } : { data: null, error: { message: 'single' } };
      if (unica === 'maybe') return { data: alvo[0] ? { ...alvo[0] } : null, error: null };
      return { data: alvo.map((r) => ({ ...r })), error: null };
    }
    return api;
  }
  return { client: { from, rpc: async () => ({ data: null, error: null }) }, tabelas };
}

function carregar(banco) {
  const raiz = path.resolve(__dirname, '../src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(raiz)) delete require.cache[k];
  const fixar = (rel, exports) => {
    const f = path.join(raiz, rel);
    require.cache[f] = { id: f, filename: f, loaded: true, exports };
  };
  const msgs = [];
  fixar('db/supabase.js', banco.client);
  fixar('services/mensageiro.js', {
    enviarTexto: async (_p, t) => { msgs.push(t); }, enviarMenu: async (_p, t) => { msgs.push(t); },
    enviarImagem: async () => {}, enviarBotaoLink: async (_p, o) => { msgs.push(o.message); },
  });
  fixar('services/cotacoes.js', { taxaParaBRLDetalhe: async () => ({ taxa: null }), taxaParaBRL: async () => null });
  fixar('services/limites.js', { verificarLimite: async () => {}, verificarLimiteEmBackground() {} });
  fixar('services/duplicadas.js', { avisarDuplicadasEmBackground() {} });
  // O ia.js instancia o cliente da OpenAI no import; nada aqui chama a IA.
  fixar('services/ia.js', { analisarGastos: async () => '', interpretarMensagem: async () => null, classificarIntencao: async () => null });
  return { req: (rel) => require(path.join(raiz, rel)), msgs };
}

const base = () => ({
  grupos: [{ id: 'g1', moeda_base: 'BRL' }],
  users: [{ id: 'u1', grupo_ativo: 'g1' }],
  wallets: [
    { id: 'wOF', grupo_id: 'g1', nome: 'Picpay', tipo: 'Corrente', saldo: 1848.51, of_conta_id: 'acc-1', moeda: 'BRL' },
    { id: 'wMan', grupo_id: 'g1', nome: 'Dinheiro', tipo: 'Dinheiro', saldo: 396, of_conta_id: null, moeda: 'BRL' },
  ],
  transacoes: [],
});
const saldo = (b, id) => b.tabelas.wallets.find((w) => w.id === id).saldo;
const ctx = { phone: '5511999990001', grupoId: 'g1', user: { id: 'u1' } };

(async () => {
  console.log('── 1. o helper ──');
  {
    const b = criarBanco(base());
    const { req } = carregar(b);
    const { moverSaldo, gravarSaldo } = req('services/saldoCarteira.js');
    eq(await moverSaldo({ id: 'wOF', saldo: 1848.51, of_conta_id: 'acc-1' }, -100), false, 'conta do banco: moverSaldo devolve false');
    eq(saldo(b, 'wOF'), 1848.51, 'conta do banco: saldo intacto');
    eq(await moverSaldo({ id: 'wMan', saldo: 396, of_conta_id: null }, -100), true, 'conta manual: moverSaldo devolve true');
    eq(saldo(b, 'wMan'), 296, 'conta manual: saldo anda');
    // sem `of_conta_id` no objeto (quem chamou não pediu a coluna): o helper lê
    eq(await moverSaldo({ id: 'wOF', saldo: 1848.51 }, -50), false, '⚠️ sem of_conta_id no objeto, o helper LÊ e ainda protege a conta do banco');
    eq(saldo(b, 'wOF'), 1848.51, 'e o saldo do banco continua intacto');
    eq(await gravarSaldo({ id: 'wOF', saldo: 0 }, 0), false, 'gravarSaldo (estorno) também não toca na conta do banco');
  }

  console.log('── 2. adicionar / alterar saldo pelo zap ──');
  for (const acao of ['adicionar_saldo', 'alterar_saldo']) {
    const b = criarBanco(base());
    const { req, msgs } = carregar(b);
    const carteiras = req('handlers/wallets.js');
    await carteiras({ acao, nome: 'Picpay', valor: '500' }, ctx);
    eq(saldo(b, 'wOF'), 1848.51, `${acao} numa conta do banco: saldo intacto`);
    ok(/conectada ao seu banco/.test(msgs.join(' ')), `${acao}: a resposta explica — veio ${msgs.join(' | ')}`);
    ok(!b.tabelas.transacoes.length, `${acao}: nenhum lançamento de Ajuste fantasma`);
  }

  console.log('── 3. transferir entre conta do banco e manual ──');
  {
    const b = criarBanco(base());
    const { req, msgs } = carregar(b);
    await req('handlers/wallets.js')({ acao: 'transferir', origem: 'Picpay', destino: 'Dinheiro', valor: 100 }, ctx);
    eq(saldo(b, 'wOF'), 1848.51, 'transferência: a ponta do banco não anda');
    eq(saldo(b, 'wMan'), 496, 'transferência: a ponta manual anda');
    ok(/conectada ao seu banco/.test(msgs.join(' ')), `transferência: a resposta explica — veio ${msgs.join(' | ')}`);
  }

  // O caminho principal: "gastei 50 no picpay" pelo zap. É o do relato.
  console.log('── 4. lançar pelo zap ──');
  for (const [conta, id, esperado, banco] of [['Picpay', 'wOF', 1848.51, true], ['Dinheiro', 'wMan', 346, false]]) {
    const b = criarBanco(base());
    const { req, msgs } = carregar(b);
    await req('handlers/transacoes.js')(
      { acao: 'salvar', tipo: 'Gasto', valor: '50', categoria: 'Outros', observacao: 'teste', carteira_nome: conta },
      { ...ctx, mensagem: `gastei 50 no ${conta}` });
    eq(saldo(b, id), esperado, `lançar em ${conta}: saldo ${banco ? 'intacto (é do banco)' : 'anda'}`);
    ok(b.tabelas.transacoes.length === 1, `lançar em ${conta}: a transação é gravada do mesmo jeito`);
    ok(/conectada ao seu banco/.test(msgs.join(' ')) === banco,
      `lançar em ${conta}: aviso ${banco ? 'presente' : 'ausente'} — veio ${msgs.join(' | ')}`);
  }

  console.log('── 5. mover lançamento de conta (a pergunta "de qual conta saiu?") ──');
  for (const [destino, id, esperado, banco] of [['Picpay', 'wOF', 1848.51, true], ['Dinheiro', 'wMan', 346, false]]) {
    const b = criarBanco({ ...base(), transacoes: [{ id: 't1', grupo_id: 'g1', tipo: 'Gasto', valor: 50, carteira_nome: 'Temporária' }] });
    const { req } = carregar(b);
    const r = await req('handlers/pendentes.js').moverCarteira('t1', destino, 'g1');
    eq(saldo(b, id), esperado, `mover pra ${destino}: saldo ${banco ? 'intacto (é do banco)' : 'anda'}`);
    eq(!!(r && r.contaDoBanco), banco, `mover pra ${destino}: contaDoBanco = ${banco}`);
  }

  // O painel tinha o mesmo furo: "Ajustar saldo" (POST), editar (PUT) e
  // transferir gravavam no saldo da conta do banco.
  console.log('── 6. painel: ajustar, editar e transferir ──');
  {
    const rota = (router, metodo, caminho) => {
      const l = router.stack.find((x) => x.route && x.route.path === caminho && x.route.methods[metodo]);
      return l.route.stack[l.route.stack.length - 1].handle;
    };
    const chamar = async (h, req) => {
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await h({ params: {}, query: {}, body: {}, grupoId: 'g1', userId: 'u1', authUser: { id: 'u1' }, ...req }, res);
      return res;
    };
    const montar = (b) => {
      const { req } = carregar(b);
      const raiz = path.resolve(__dirname, '../src');
      for (const [rel, exp] of [['middlewares/auth.js', (q, s, n) => n()],
        ['middlewares/permissao.js', { exigirPermissao: () => (q, s, n) => n() }]]) {
        const f = path.join(raiz, rel); require.cache[f] = { id: f, filename: f, loaded: true, exports: exp };
      }
      return req('routes/wallets.js');
    };

    // Ajustar saldo (POST com o mesmo nome)
    for (const [nome, id, esperado, banco] of [['Picpay', 'wOF', 1848.51, true], ['Dinheiro', 'wMan', 500, false]]) {
      const b = criarBanco(base());
      const r = await chamar(rota(montar(b), 'post', '/'), { body: { nome, tipo: 'Corrente', saldo: 500 } });
      eq(saldo(b, id), esperado, `ajustar ${nome} pelo painel: saldo ${banco ? 'intacto (é do banco)' : 'vira 500'} — status ${r.statusCode}`);
      eq(b.tabelas.transacoes.length, banco ? 0 : 1, `ajustar ${nome}: ${banco ? 'nenhum Ajuste fantasma' : 'o Ajuste é registrado'}`);
    }

    // Editar (PUT) mandando saldo
    {
      const b = criarBanco(base());
      await chamar(rota(montar(b), 'put', '/:id'), { params: { id: 'wOF' }, body: { saldo: 10, limite: 0 } });
      eq(saldo(b, 'wOF'), 1848.51, 'editar a conta do banco mandando saldo: saldo intacto');
    }

    // Transferir
    {
      const b = criarBanco(base());
      await chamar(rota(montar(b), 'post', '/transferir'), { body: { origem_id: 'wOF', destino_id: 'wMan', valor: 100 } });
      eq([saldo(b, 'wOF'), saldo(b, 'wMan')], [1848.51, 496], 'transferir pelo painel: só a ponta manual anda');
    }

    // ── 7. De qual conta sai a fatura (migration 170) ──
    console.log('── 7. conta de pagamento da fatura ──');
    {
      const comCartao = () => ({
        ...base(),
        wallets: [
          ...base().wallets,
          { id: 'wCard', grupo_id: 'g1', nome: 'Cartão X', tipo: 'Crédito', saldo: -300 },
          { id: 'wCard2', grupo_id: 'g1', nome: 'Cartão Y', tipo: 'Crédito', saldo: 0 },
          { id: 'wAlheia', grupo_id: 'OUTRO', nome: 'Conta de outra família', tipo: 'Corrente', saldo: 10 },
        ],
      });
      const put = async (b, id, conta) => chamar(rota(montar(b), 'put', '/:id'), { params: { id }, body: { conta_pagamento_id: conta } });
      const cp = (b) => b.tabelas.wallets.find((w) => w.id === 'wCard').conta_pagamento_id;

      let b = criarBanco(comCartao());
      let r = await put(b, 'wCard', 'wMan');
      eq([r.statusCode, cp(b)], [200, 'wMan'], 'cartão aponta pra uma conta de débito do grupo');
      r = await put(b, 'wCard', null);
      eq([r.statusCode, cp(b)], [200, null], 'null desfaz a escolha');

      b = criarBanco(comCartao());
      r = await put(b, 'wCard', 'wAlheia');
      eq([r.statusCode, cp(b)], [400, undefined], '⚠️ conta de OUTRO grupo é recusada (senão ligaria à família errada)');
      r = await put(b, 'wCard', 'wCard2');
      eq([r.statusCode, cp(b)], [400, undefined], 'cartão não paga cartão');
      r = await put(b, 'wMan', 'wOF');
      eq(r.statusCode, 400, 'conta bancária não tem conta de pagamento');
    }
  }

  console.log('');
  if (falhas.length) {
    console.log(`❌ ${falhas.length} falha(s):`);
    for (const f of falhas) console.log('   · ' + f);
    process.exit(1);
  }
  console.log('✅ conta do banco: o WhatsApp não mexe no saldo, e explica');
})().catch((e) => { console.error(e); process.exit(1); });

function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); }
