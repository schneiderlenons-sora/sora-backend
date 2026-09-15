// =============================================================================
// EVAL — "Paguei" nos Previstos (POST /api/previstos/quitar) × saldo da conta.
//
// Caso real (set/2026): plano de saúde de R$ 1.700 numa conta manual. A baixa
// gravava a transação paga SEM debitar o saldo; o "Ainda não paguei" (PUT)
// devolvia os R$ 1.700 — dinheiro que nunca existiu. E a ocorrência 06/11 foi
// marcada como paga em setembro, com data no futuro.
//
// O que este eval trava, passando pelas ROTAS DE VERDADE (previstos /quitar,
// transacoes PUT e DELETE) com um Supabase falso em memória:
//   1. "Paguei" debita a conta manual; "Ainda não paguei" devolve; o saldo
//      volta EXATAMENTE ao de partida (ida e volta = zero).
//   2. Ocorrência pendente volta a ser paga (antes respondia "já quitada").
//   3. Dois toques, em série ou simultâneos: uma linha, um débito.
//   4. Data no futuro é recusada (400) sem escrever nada.
//   5. Open Finance: nem a baixa nem o DELETE tocam o saldo (regra de ouro).
//   6. Moeda estrangeira, conta inexistente e transferência não debitam.
//   7. Apagar a baixa estorna o que ela debitou (e só isso).
//   8. "Dar baixa" pela sugestão do banco AMARRA a cobrança existente: nenhuma
//      linha nova, nenhum débito (antes criava a duplicata).
//
// Rodar:  npm run eval:quitacao
// =============================================================================
const path = require('path');
const { hojeSP } = require('../src/services/cicloFatura');

// ── Supabase falso ───────────────────────────────────────────────────────────
function criarBanco(inicial) {
  const tabelas = {
    users: [], wallets: [], recorrencias: [], transacoes: [], previsao_ajustes: [], of_tx_ignoradas: [],
    ...JSON.parse(JSON.stringify(inicial)),
  };
  let seq = 0;

  function from(nome) {
    const filtros = [];
    const ordens = [];
    let modo = 'select', payload = null, retornar = false, unica = null, limite = null;
    const api = {
      select() { if (modo !== 'select') retornar = true; return api; },
      insert(p) { modo = 'insert'; payload = p; return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      upsert(p) { modo = 'upsert'; payload = p; return api; },
      delete() { modo = 'delete'; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      ilike(c, v) { filtros.push((r) => String(r[c] ?? '').toLowerCase() === String(v ?? '').toLowerCase()); return api; },
      is(c, v) { filtros.push((r) => (r[c] ?? null) === v); return api; },
      in(c, arr) { const s = new Set(arr); filtros.push((r) => s.has(r[c])); return api; },
      order(c, o) { ordens.push([c, o?.ascending !== false]); return api; },
      limit(n) { limite = n; return api; },
      single() { unica = 'single'; return api; },
      maybeSingle() { unica = 'maybe'; return api; },
      then(ok, erro) {
        return Promise.resolve().then(() => executar()).then(ok, erro);
      },
    };
    function responder(linhas) {
      if (unica === 'single') {
        return linhas.length === 1 ? { data: { ...linhas[0] }, error: null } : { data: null, error: { message: `single: ${linhas.length} linhas` } };
      }
      if (unica === 'maybe') {
        if (linhas.length > 1) return { data: null, error: { message: 'multiple rows' } };
        return { data: linhas[0] ? { ...linhas[0] } : null, error: null };
      }
      return { data: linhas.map((r) => ({ ...r })), error: null };
    }
    function executar() {
      const t = tabelas[nome] || (tabelas[nome] = []);
      if (modo === 'insert') {
        const novas = (Array.isArray(payload) ? payload : [payload]).map((p) => ({
          id: `${nome}-${++seq}`, created_at: String(seq).padStart(6, '0'), ...p,
        }));
        t.push(...novas);
        return responder(novas);
      }
      if (modo === 'upsert') return { data: null, error: null };
      let alvo = t.filter((r) => filtros.every((f) => f(r)));
      if (modo === 'update') {
        alvo.forEach((r) => Object.assign(r, payload));
        return retornar || unica ? responder(alvo) : { data: null, error: null };
      }
      if (modo === 'delete') {
        tabelas[nome] = t.filter((r) => !alvo.includes(r));
        return { data: null, error: null };
      }
      for (const [c, asc] of [...ordens].reverse()) {
        alvo = [...alvo].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limite != null) alvo = alvo.slice(0, limite);
      return responder(alvo);
    }
    return api;
  }
  return { client: { from }, tabelas };
}

// Carrega as rotas reais com o banco falso e os middlewares liberados.
function carregarRotas(banco) {
  const raiz = path.resolve(__dirname, '../src');
  const fixar = (rel, exports) => {
    const f = path.join(raiz, rel);
    require.cache[f] = { id: f, filename: f, loaded: true, exports };
  };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(raiz) && !k.endsWith('cicloFatura.js')) delete require.cache[k];
  }
  fixar('db/supabase.js', banco.client);
  fixar('middlewares/auth.js', (req, res, next) => next());
  fixar('middlewares/permissao.js', { exigirPermissao: () => (req, res, next) => next() });
  const handler = (router, metodo, rota) => {
    const layer = router.stack.find((l) => l.route && l.route.path === rota && l.route.methods[metodo]);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  const previstos = require(path.join(raiz, 'routes/previstos.js'));
  const transacoes = require(path.join(raiz, 'routes/transacoes.js'));
  const chamar = async (h, req) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await h({ params: {}, query: {}, body: {}, authUser: { id: 'u1' }, grupoId: 'g1', userId: 'u1', ...req }, res);
    return res;
  };
  return {
    quitar: (body) => chamar(handler(previstos, 'post', '/quitar'), { body }),
    editar: (id, body) => chamar(handler(transacoes, 'put', '/:id'), { params: { id }, body }),
    apagar: (id) => chamar(handler(transacoes, 'delete', '/:id'), { params: { id } }),
  };
}

// ── Cenário ──────────────────────────────────────────────────────────────────
const HOJE = hojeSP();
const COMP = HOJE.slice(0, 7);
function cenario() {
  return {
    users: [{ id: 'u1', grupo_ativo: 'g1' }],
    wallets: [
      { id: 'w-inter', grupo_id: 'g1', nome: 'Inter PJ', tipo: 'Conta', saldo: 5217.71, moeda: 'BRL', of_conta_id: null },
      { id: 'w-of', grupo_id: 'g1', nome: 'Nubank', tipo: 'Conta', saldo: 900, moeda: 'BRL', of_conta_id: 'acc-1' },
      { id: 'w-eur', grupo_id: 'g1', nome: 'Wise EUR', tipo: 'Conta', saldo: 300, moeda: 'EUR', of_conta_id: null },
      { id: 'w-velha', grupo_id: 'g1', nome: 'Carteira', tipo: 'Conta', saldo: 100, of_conta_id: null }, // sem coluna moeda (pré-144)
    ],
    recorrencias: [
      { id: 'r-saude', grupo_id: 'g1', tipo: 'Gasto', valor: 1700, categoria: 'Saúde', descricao: 'Plano de Saúde', carteira: 'Inter PJ' },
      { id: 'r-cliente', grupo_id: 'g1', tipo: 'Recebimento', valor: 800, categoria: 'Serviços', descricao: 'Cliente X', carteira: 'Inter PJ' },
      { id: 'r-of', grupo_id: 'g1', tipo: 'Gasto', valor: 120, categoria: 'Casa', descricao: 'Internet', carteira: 'Nubank' },
      { id: 'r-eur', grupo_id: 'g1', tipo: 'Gasto', valor: 50, categoria: 'Assinaturas', descricao: 'Spotify', carteira: 'Wise EUR' },
      { id: 'r-transf', grupo_id: 'g1', tipo: 'Gasto', valor: 400, categoria: 'Transferências', descricao: 'Reserva', carteira: 'Inter PJ' },
      { id: 'r-velha', grupo_id: 'g1', tipo: 'Gasto', valor: 30, categoria: 'Casa', descricao: 'Gás', carteira: 'Carteira' },
      { id: 'r-fantasma', grupo_id: 'g1', tipo: 'Gasto', valor: 60, categoria: 'Casa', descricao: 'Água', carteira: 'Conta Apagada' },
    ],
  };
}

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const saldo = (banco, id) => Math.round(banco.tabelas.wallets.find((w) => w.id === id).saldo * 100) / 100;
const linhas = (banco, rec) => banco.tabelas.transacoes.filter((t) => t.recorrencia_id === rec);

(async () => {
  console.log('── 1. Paguei → Ainda não paguei → Paguei → apagar: o saldo fecha ──');
  {
    const b = criarBanco(cenario()); const r = carregarRotas(b);
    const q1 = await r.quitar({ recorrencia_id: 'r-saude', competencia: COMP, data: HOJE, valor: 1700, carteira_nome: 'Inter PJ' });
    eq(q1.statusCode, 200, 'baixa responde 200');
    eq(saldo(b, 'w-inter'), 3517.71, '⚠️ "Paguei" DEBITA a conta manual (antes ficava 5217,71)');
    eq(linhas(b, 'r-saude').length, 1, 'uma linha criada');
    eq(linhas(b, 'r-saude')[0].pago, true, 'linha nasce paga');

    const id = linhas(b, 'r-saude')[0].id;
    await r.editar(id, { pago: false });
    eq(saldo(b, 'w-inter'), 5217.71, '⚠️ "Ainda não paguei" devolve e o saldo volta AO DE PARTIDA (antes subia pra 6917,71)');

    const q2 = await r.quitar({ recorrencia_id: 'r-saude', competencia: COMP, data: HOJE, valor: 1700, carteira_nome: 'Inter PJ' });
    eq(q2.body.jaQuitada, undefined, '⚠️ ocorrência pendente VOLTA a ser paga (antes: "já quitada" e nada)');
    eq(q2.body.id, id, 'reusa a mesma linha');
    eq(linhas(b, 'r-saude').length, 1, 'continua uma linha só');
    eq(linhas(b, 'r-saude')[0].pago, true, 'linha paga de novo');
    eq(saldo(b, 'w-inter'), 3517.71, 'debitada uma vez');

    const q3 = await r.quitar({ recorrencia_id: 'r-saude', competencia: COMP, data: HOJE, valor: 1700, carteira_nome: 'Inter PJ' });
    eq(q3.body.jaQuitada, true, 'terceiro toque: já quitada');
    eq(saldo(b, 'w-inter'), 3517.71, '⚠️ sem débito em dobro');

    await r.apagar(id);
    eq(saldo(b, 'w-inter'), 5217.71, 'apagar a baixa estorna exatamente o que ela debitou');
    eq(linhas(b, 'r-saude').length, 0, 'linha apagada');
  }
  console.log('  ok');

  console.log('── 2. dois toques SIMULTÂNEOS: uma linha, um débito ──');
  {
    const b = criarBanco(cenario()); const r = carregarRotas(b);
    const corpo = { recorrencia_id: 'r-saude', competencia: COMP, data: HOJE, valor: 1700, carteira_nome: 'Inter PJ' };
    const [a, c] = await Promise.all([r.quitar(corpo), r.quitar(corpo)]);
    eq(a.statusCode, 200, 'toque A 200');
    eq(c.statusCode, 200, 'toque B 200');
    eq(linhas(b, 'r-saude').length, 1, '⚠️ sobra UMA linha');
    eq(saldo(b, 'w-inter'), 3517.71, '⚠️ debitado UMA vez');
    eq(a.body.id, c.body.id, 'os dois toques devolvem a mesma linha');
  }
  console.log('  ok');

  console.log('── 3. data no futuro é recusada ──');
  {
    const b = criarBanco(cenario()); const r = carregarRotas(b);
    const q = await r.quitar({ recorrencia_id: 'r-saude', competencia: '2099-11', data: '2099-11-06', valor: 1700, carteira_nome: 'Inter PJ' });
    eq(q.statusCode, 400, '⚠️ pagamento com data futura → 400');
    eq(q.body.erro, 'data_futura', 'erro nomeado');
    eq(linhas(b, 'r-saude').length, 0, 'nada gravado');
    eq(saldo(b, 'w-inter'), 5217.71, 'saldo intacto');
    const hojeOk = await r.quitar({ recorrencia_id: 'r-saude', competencia: COMP, data: HOJE, carteira_nome: 'Inter PJ' });
    eq(hojeOk.statusCode, 200, 'hoje é aceito (o limite é inclusivo)');
    const semData = criarBanco(cenario()); const r2 = carregarRotas(semData);
    await r2.quitar({ recorrencia_id: 'r-saude', competencia: COMP });
    eq(linhas(semData, 'r-saude')[0].data, HOJE, 'sem data na chamada vale hoje (SP)');
    eq(saldo(semData, 'w-inter'), 3517.71, 'sem carteira na chamada usa a da conta fixa e debita');
  }
  console.log('  ok');

  console.log('── 4. receita soma ──');
  {
    const b = criarBanco(cenario()); const r = carregarRotas(b);
    await r.quitar({ recorrencia_id: 'r-cliente', competencia: COMP, data: HOJE, valor: 850, carteira_nome: 'Inter PJ' });
    eq(saldo(b, 'w-inter'), 6067.71, 'recebimento soma o valor informado');
    await r.editar(linhas(b, 'r-cliente')[0].id, { pago: false });
    eq(saldo(b, 'w-inter'), 5217.71, 'e "ainda não recebi" tira de volta');
  }
  console.log('  ok');

  console.log('── 5. ⚠️ Open Finance: saldo do banco não é tocado ──');
  {
    const b = criarBanco(cenario()); const r = carregarRotas(b);
    const q = await r.quitar({ recorrencia_id: 'r-of', competencia: COMP, data: HOJE, valor: 120, carteira_nome: 'Nubank' });
    eq(q.statusCode, 200, 'baixa em conta OF funciona');
    eq(linhas(b, 'r-of').length, 1, 'linha criada');
    eq(saldo(b, 'w-of'), 900, '⚠️ baixa não debita conta OF');
    await r.editar(linhas(b, 'r-of')[0].id, { pago: false });
    eq(saldo(b, 'w-of'), 900, 'PUT não mexe (já era assim)');
    await r.editar(linhas(b, 'r-of')[0].id, { pago: true });
    await r.apagar(linhas(b, 'r-of')[0].id);
    eq(saldo(b, 'w-of'), 900, '⚠️ DELETE de linha paga em conta OF não estorna (antes somava 120)');
  }
  console.log('  ok');

  console.log('── 6. o que NÃO debita ──');
  {
    const b = criarBanco(cenario()); const r = carregarRotas(b);
    await r.quitar({ recorrencia_id: 'r-eur', competencia: COMP, data: HOJE, carteira_nome: 'Wise EUR' });
    eq(saldo(b, 'w-eur'), 300, 'moeda estrangeira: fica como estava (sem valor nativo na conta fixa)');
    await r.quitar({ recorrencia_id: 'r-transf', competencia: COMP, data: HOJE, carteira_nome: 'Inter PJ' });
    eq(saldo(b, 'w-inter'), 5217.71, 'transferência não debita (mesmo "especial" do PUT)');
    await r.editar(linhas(b, 'r-transf')[0].id, { pago: false });
    eq(saldo(b, 'w-inter'), 5217.71, 'e o PUT também não devolve — segue simétrico');
    const f = await r.quitar({ recorrencia_id: 'r-fantasma', competencia: COMP, data: HOJE });
    eq(f.statusCode, 200, 'conta inexistente não quebra a baixa');
    eq(linhas(b, 'r-fantasma').length, 1, 'e a linha é gravada');
    await r.quitar({ recorrencia_id: 'r-velha', competencia: COMP, data: HOJE, carteira_nome: 'carteira' });
    eq(saldo(b, 'w-velha'), 70, 'carteira sem coluna moeda é BRL; nome casa sem diferenciar caixa (igual ao ilike)');
  }
  console.log('  ok');

  console.log('── 7. pendente de conta variável mantém o PRÓPRIO valor ──');
  {
    const base = cenario();
    base.transacoes = [{
      id: 'tx-luz', grupo_id: 'g1', tipo: 'Gasto', valor: 243.5, categoria: 'Casa', carteira_nome: 'Inter PJ',
      data: HOJE, pago: false, recorrencia_id: 'r-saude', competencia: COMP, created_at: '000000',
    }];
    const b = criarBanco(base); const r = carregarRotas(b);
    const q = await r.quitar({ recorrencia_id: 'r-saude', competencia: COMP, data: HOJE });
    eq(q.body.reaberta, true, 'pendente reaberto');
    eq(b.tabelas.transacoes[0].valor, 243.5, 'sem valor na chamada vale o da linha, não os 1.700 da conta fixa');
    eq(saldo(b, 'w-inter'), 4974.21, 'debita o valor da linha');
    eq(linhas(b, 'r-saude').length, 1, 'sem linha nova');
  }
  console.log('  ok');

  console.log('── 8. ⚠️ "Dar baixa" da sugestão do banco AMARRA, não cria ──');
  {
    const base = cenario();
    base.transacoes = [
      { id: 'tx-banco', grupo_id: 'g1', tipo: 'Gasto', valor: 1700, categoria: 'Saúde', carteira_nome: 'Nubank',
        data: HOJE, pago: true, of_tx_id: 'of-1', recorrencia_id: null, competencia: null, created_at: '000000' },
      { id: 'tx-outra', grupo_id: 'g1', tipo: 'Gasto', valor: 99, categoria: 'Casa', carteira_nome: 'Nubank',
        data: HOJE, pago: true, of_tx_id: 'of-2', recorrencia_id: 'r-of', competencia: COMP, created_at: '000001' },
    ];
    const b = criarBanco(base); const r = carregarRotas(b);
    // A conta fixa é da conta MANUAL; a cobrança caiu no Nubank (OF).
    const q = await r.quitar({ recorrencia_id: 'r-saude', competencia: COMP, data: HOJE, valor: 1700, carteira_nome: 'Inter PJ', transacao_id: 'tx-banco' });
    eq(q.statusCode, 200, 'baixa pela sugestão responde 200');
    eq(q.body.vinculada, true, 'amarrou');
    eq(b.tabelas.transacoes.length, 2, '⚠️ NENHUMA linha nova (antes criava a duplicata da cobrança)');
    eq(b.tabelas.transacoes[0].recorrencia_id, 'r-saude', 'a cobrança do banco ganha o vínculo');
    eq(b.tabelas.transacoes[0].competencia, COMP, 'na competência certa');
    eq(saldo(b, 'w-inter'), 5217.71, '⚠️ a conta manual NÃO é debitada por um pagamento que saiu do Nubank');
    eq(saldo(b, 'w-of'), 900, 'e a do banco segue a do banco');
    const de2 = await r.quitar({ recorrencia_id: 'r-saude', competencia: COMP, transacao_id: 'tx-banco' });
    eq(de2.body.jaQuitada, true, 'segundo toque: já quitada');
    const presa = await r.quitar({ recorrencia_id: 'r-cliente', competencia: COMP, transacao_id: 'tx-outra' });
    eq(presa.statusCode, 409, 'transação já amarrada a outra conta fixa não é roubada');
    eq(b.tabelas.transacoes[1].recorrencia_id, 'r-of', 'vínculo original intacto');
    const alheia = await r.quitar({ recorrencia_id: 'r-cliente', competencia: COMP, transacao_id: 'tx-de-outro-grupo' });
    eq(alheia.statusCode, 404, 'transação que não é do grupo → 404');
    // Ocorrência já resolvida por outra linha: não amarra a segunda.
    const b2 = criarBanco({ ...base, transacoes: [
      { ...base.transacoes[0] },
      { id: 'tx-manual', grupo_id: 'g1', tipo: 'Gasto', valor: 1700, carteira_nome: 'Inter PJ', data: HOJE, pago: true,
        recorrencia_id: 'r-saude', competencia: COMP, created_at: '000002' },
    ] });
    const r2 = carregarRotas(b2);
    const dup = await r2.quitar({ recorrencia_id: 'r-saude', competencia: COMP, transacao_id: 'tx-banco' });
    eq(dup.body.jaQuitada, true, 'ocorrência já quitada por outra linha');
    eq(b2.tabelas.transacoes[0].recorrencia_id, null, 'a cobrança do banco não vira segundo pagamento da mesma ocorrência');
  }
  console.log('  ok');

  console.log('── 9. validação de entrada segue igual ──');
  {
    const b = criarBanco(cenario()); const r = carregarRotas(b);
    eq((await r.quitar({ recorrencia_id: 'r-saude', competencia: '2026/09' })).statusCode, 400, 'competência inválida');
    eq((await r.quitar({ recorrencia_id: 'r-saude', competencia: COMP, data: '06/11/2026' })).statusCode, 400, 'data inválida');
    eq((await r.quitar({ recorrencia_id: 'r-outra', competencia: COMP })).statusCode, 404, 'conta fixa de outro grupo');
    eq(b.tabelas.transacoes.length, 0, 'nada gravado');
  }
  console.log('  ok');

  console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
  if (falhas.length) { falhas.forEach((x) => console.log('  · ' + x)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
