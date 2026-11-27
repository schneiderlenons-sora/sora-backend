// =============================================================================
// EVAL — compra do cartão dividida com outra pessoa (migration 206).
//
// Pedido do Arisson (nov/2026): "comprei uma geladeira de R$ 3.000 em 10x de
// R$ 300 e minha esposa paga metade".
//
//   §1 as regras puras: nome, metade/valor, o que pode ser dividido, o plano
//      de gravação (tudo ou nada), os acertos e as entradas candidatas;
//   §2 as rotas com banco falso: dividir (e as parcelas irmãs), tirar a
//      divisão, sem a 206 nada quebra, acertos (conta manual, conta do banco,
//      entrada ligada, registro) e o desfazer de cada um;
//   §3 criar a compra já dividida (avulsa e parcelada) e o "Pagar fatura" com
//      a parte paga por fora virando acerto.
//
// Rodar:  node evals/divisaoCompra.eval.js
// =============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-eval-sem-rede';
const Module = require('module');
const path = require('path');
const RAIZ = path.resolve(__dirname, '..');

const falhas = [];
let total = 0;
const ok = (c, m) => { total++; if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}\n      esperado ${JSON.stringify(b)}\n      veio     ${JSON.stringify(a)}`);

const LOAD_ORIGINAL = Module._load;
let stubsAtuais = {};
Module._load = function (req, parent, isMain) {
  for (const [suf, exp] of Object.entries(stubsAtuais)) if (req.endsWith(suf)) return exp;
  return LOAD_ORIGINAL.call(this, req, parent, isMain);
};
function carregar(rel, stubs) {
  stubsAtuais = stubs;
  for (const k of Object.keys(require.cache)) if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  return require(path.join(RAIZ, rel));
}

// ── banco falso ──────────────────────────────────────────────────────────────
// eq · in · not(is null) · gte · lt · ilike (igualdade sem caixa) · neq · order
// · limit · maybeSingle · single · select depois de insert/update · delete.
// `cfg.sem206`: a tabela de acertos não existe e as colunas da divisão também.
function mundo(tabelas = {}, cfg = {}) {
  const log = [];
  let seq = 0;
  const from = (nome) => {
    const filtros = [];
    let modo = 'select', patch = null, colunas = '*', lim = null;
    const casa = (r) => filtros.every(([op, c, v]) => {
      if (op === 'eq') return r[c] === v;
      if (op === 'neq') return r[c] !== v;
      if (op === 'in') return v.includes(r[c]);
      if (op === 'notnull') return r[c] != null;
      if (op === 'gte') return String(r[c]) >= String(v);
      if (op === 'lt') return String(r[c]) < String(v);
      if (op === 'ilike') return String(r[c] ?? '').toLowerCase() === String(v).toLowerCase();
      return true;
    });
    const falta = () => {
      if (!cfg.sem206) return null;
      if (nome === 'divisoes_acertos') return { message: 'relation "public.divisoes_acertos" does not exist' };
      const toca = (o) => o && Object.keys(o).some((k) => k === 'dividida_com' || k === 'parte_outro');
      if ((modo === 'update' || modo === 'insert') && (Array.isArray(patch) ? patch.some(toca) : toca(patch))) {
        return { message: 'column "dividida_com" of relation "transacoes" does not exist' };
      }
      if (modo === 'select' && /dividida_com|parte_outro/.test(colunas)) return { message: 'column transacoes.dividida_com does not exist' };
      return null;
    };
    const exec = (unico) => {
      const err = falta();
      if (err) return { data: null, error: err };
      if (cfg.falhar && cfg.falhar(nome, modo, patch)) return { data: null, error: { message: 'falha simulada' } };
      const rows = (tabelas[nome] = tabelas[nome] || []);
      if (modo === 'select') {
        let l = rows.filter(casa);
        if (lim != null) l = l.slice(0, lim);
        return { data: unico ? (l[0] || null) : l, error: null };
      }
      if (modo === 'insert') {
        const lista = (Array.isArray(patch) ? patch : [patch]).map((p) => ({ id: `n${++seq}`, ...p }));
        rows.push(...lista);
        log.push(['insert', nome, lista.length]);
        return { data: unico ? lista[0] : lista, error: null };
      }
      if (modo === 'update') {
        const alvo = rows.filter(casa);
        alvo.forEach((r) => Object.assign(r, patch));
        log.push(['update', nome, { ...patch }, alvo.length]);
        return { data: unico ? (alvo[0] || null) : alvo, error: null };
      }
      if (modo === 'delete') {
        const fica = rows.filter((r) => !casa(r));
        const saiu = rows.length - fica.length;
        tabelas[nome] = fica;
        log.push(['delete', nome, saiu]);
        // ON DELETE CASCADE de divisoes_acertos.transacao_id
        if (nome === 'transacoes' && tabelas.divisoes_acertos) {
          const vivos = new Set(fica.map((t) => t.id));
          tabelas.divisoes_acertos = tabelas.divisoes_acertos.filter((a) => !a.transacao_id || vivos.has(a.transacao_id));
        }
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };
    const q = {
      select(c) { if (modo === 'select') colunas = c || '*'; return q; },
      insert(p) { modo = 'insert'; patch = p; return q; },
      update(p) { modo = 'update'; patch = p; return q; },
      delete() { modo = 'delete'; return q; },
      eq(c, v) { filtros.push(['eq', c, v]); return q; },
      neq(c, v) { filtros.push(['neq', c, v]); return q; },
      in(c, v) { filtros.push(['in', c, v]); return q; },
      not(c, op, v) { if (op === 'is' && v === null) filtros.push(['notnull', c]); return q; },
      gte(c, v) { filtros.push(['gte', c, v]); return q; },
      lt(c, v) { filtros.push(['lt', c, v]); return q; },
      ilike(c, v) { filtros.push(['ilike', c, v]); return q; },
      or() { return q; }, order() { return q; },
      limit(n) { lim = n; return q; },
      maybeSingle() { return Promise.resolve(exec(true)); },
      single() { return Promise.resolve(exec(true)); },
      then(ok2, ko) { return Promise.resolve(exec(false)).then(ok2, ko); },
    };
    return q;
  };
  return { db: { from }, tabelas, log };
}

(async () => {
  const D = require(path.join(RAIZ, 'src/services/divisaoCompra.js'));

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 1. regras ──');
  eq([D.normalizarPessoa('  Minha   esposa '), D.normalizarPessoa(''), D.normalizarPessoa(null)], ['Minha esposa', null, null], '§1 nome sem espaço sobrando; vazio é null');
  eq(D.chavePessoa('Esposa'), D.chavePessoa('  ESPÔSA  '), '§1 mesma pessoa sem acento nem caixa');
  eq(D.validarDivisao(null), { ok: true, divisao: null }, '§1 null tira a divisão');
  eq(D.validarDivisao({ remover: true }), { ok: true, divisao: null }, '§1 remover tira a divisão');
  eq(D.validarDivisao({ com: 'Esposa', modo: 'metade' }), { ok: true, divisao: { com: 'Esposa', modo: 'metade' } }, '§1 metade');
  eq(D.validarDivisao({ com: 'Esposa', modo: 'valor', valor: '150.004' }), { ok: true, divisao: { com: 'Esposa', modo: 'valor', valor: 150 } }, '§1 valor em centavos');
  eq(D.validarDivisao({ com: ' ', modo: 'metade' }).ok, false, '§1 sem nome: recusa');
  eq(D.validarDivisao({ com: 'x'.repeat(61), modo: 'metade' }).ok, false, '§1 nome de 61 letras: recusa');
  eq(D.validarDivisao({ com: 'Esposa', modo: 'valor', valor: 0 }).ok, false, '§1 valor zero: recusa');
  eq(D.validarDivisao({ com: 'Esposa', modo: 'terço' }).ok, false, '§1 modo desconhecido: recusa');

  eq([D.parteDoOutro(300, { modo: 'metade' }), D.parteDoOutro(300.01, { modo: 'metade' }), D.parteDoOutro(0.01, { modo: 'metade' })],
    [150, 150, null], '§1 metade: o centavo ímpar fica com quem passou o cartão; 1 centavo não divide');
  eq([D.parteDoOutro(300, { modo: 'valor', valor: 100 }), D.parteDoOutro(300, { modo: 'valor', valor: 300 }), D.parteDoOutro(300, { modo: 'valor', valor: 300.01 })],
    [100, 300, null], '§1 valor: até o valor da linha (a compra inteira pode ser da outra pessoa)');

  const cartao = { tipo: 'Crédito' };
  const compra = { tipo: 'Gasto', categoria: 'Eletrodomésticos', valor: 300 };
  eq(D.motivoNaoDivide(compra, cartao), null, '§1 compra no cartão: pode');
  ok(/cartão/.test(D.motivoNaoDivide(compra, { tipo: 'Corrente' })), '§1 compra na conta: ainda não');
  ok(!!D.motivoNaoDivide({ ...compra, tipo: 'Recebimento' }, cartao), '§1 entrada: não');
  ok(!!D.motivoNaoDivide({ ...compra, transferencia: true }, cartao), '§1 transferência: não');
  ok(!!D.motivoNaoDivide({ ...compra, categoria: '💳 Fatura' }, cartao), '§1 pagamento de fatura (com emoji): não');
  ok(!!D.motivoNaoDivide({ ...compra, categoria: 'Fatura anterior' }, cartao), '§1 fatura anterior: não');
  ok(!!D.motivoNaoDivide({ ...compra, moeda: 'USD' }, cartao), '§1 compra em outra moeda: ainda não');
  ok(!!D.motivoNaoDivide(null, cartao), '§1 sem lançamento: não');

  const linhas = [{ id: 'a', valor: 300 }, { id: 'b', valor: 300, dividida_com: 'Esposa', parte_outro: 150 }, { id: 'c', valor: 300.01 }];
  eq(D.planoDaDivisao(linhas, { com: 'Esposa', modo: 'metade' }),
    { ok: true, patches: [{ id: 'a', patch: { dividida_com: 'Esposa', parte_outro: 150 } }, { id: 'c', patch: { dividida_com: 'Esposa', parte_outro: 150 } }] },
    '§1 plano: só grava o que muda');
  eq(D.planoDaDivisao([{ id: 'a', valor: 300 }, { id: 'b', valor: 50 }], { com: 'E', modo: 'valor', valor: 100 }).ok, false,
    '⚠️ §1 valor maior que UMA das parcelas: nada é gravado (tudo ou nada)');
  eq(D.planoDaDivisao(linhas, null), { ok: true, patches: [{ id: 'b', patch: { dividida_com: null, parte_outro: null } }] }, '§1 tirar: só as que estavam divididas');

  eq(D.validarAcerto({ cartao_id: 'c', competencia: '2026-11', pessoa: 'Esposa', valor: 150, forma: 'registro' }).acerto,
    { cartao_id: 'c', competencia: '2026-11', pessoa: 'Esposa', pessoa_chave: 'esposa', valor: 150, forma: 'registro', wallet_id: null, transacao_id: null },
    '§1 acerto de registro');
  eq(D.validarAcerto({ cartao_id: 'c', competencia: '2026-11', pessoa: 'E', valor: 150, forma: 'fatura' }).ok, false, '⚠️ §1 "fatura" só nasce pelo Pagar fatura');
  eq(D.validarAcerto({ cartao_id: 'c', competencia: '2026-11', pessoa: 'E', valor: 150, forma: 'conta' }).ok, false, '§1 conta sem conta: recusa');
  eq(D.validarAcerto({ cartao_id: 'c', competencia: '2026-11', pessoa: 'E', valor: 150, forma: 'vincular' }).ok, false, '§1 ligar sem lançamento: recusa');
  eq(D.validarAcerto({ cartao_id: 'c', competencia: '11/2026', pessoa: 'E', valor: 150, forma: 'registro' }).ok, false, '§1 fatura inválida: recusa');
  eq(D.validarAcerto({ cartao_id: 'c', competencia: '2026-11', pessoa: 'E', valor: 0, forma: 'registro' }).ok, false, '§1 valor zero: recusa');

  const cands = D.candidatosDeRecebimento([
    { id: '1', tipo: 'Recebimento', valor: 1500, data: '2026-11-20' },
    { id: '2', tipo: 'Recebimento', valor: 5000, data: '2026-11-25' },
    { id: '3', tipo: 'Recebimento', valor: 1600, data: '2026-11-26', transferencia: true },
    { id: '4', tipo: 'Recebimento', valor: 1500, data: '2026-11-24', ignorar_em: 'regra' },
    { id: '5', tipo: 'Gasto', valor: 1500, data: '2026-11-24' },
    { id: '6', tipo: 'Recebimento', valor: 1490, data: '2026-11-26' },
    { id: '7', tipo: 'Recebimento', valor: 1500, data: '2026-11-21' },
  ], { esperado: 1500, jaUsados: new Set(['7']) });
  eq(cands.map((c) => c.id), ['1', '6', '2'], '§1 entradas candidatas: valor mais próximo primeiro; tira transferência, ignorada, saída e já usada');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 2. as rotas ──');
  const stubsDe = (m) => ({
    'db/supabase': m.db,
    'middlewares/auth': (rq, rs, nx) => { rq.authUser = { id: 'u', grupoAtivo: 'g' }; nx(); },
    'middlewares/permissao': { exigirPermissao: () => (rq, rs, nx) => { rq.grupoId = 'g'; rq.userId = 'u'; nx(); } },
  });
  async function chamar(arquivo, metodo, caminho, { params = {}, body = {}, query = {}, tabelas = {}, cfg = {} }) {
    const m = mundo(tabelas, cfg);
    const router = carregar(arquivo, stubsDe(m));
    const camada = router.stack.find((c) => c.route?.path === caminho && c.route?.methods?.[metodo]);
    if (!camada) throw new Error(`rota ${metodo} ${caminho} não existe`);
    const pilha = camada.route.stack.map((s) => s.handle);
    let status = 200, json = null;
    const req = { params, body, query, authUser: { id: 'u', grupoAtivo: 'g' } };
    const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; } };
    let i = 0;
    const prox = async () => { const h = pilha[i++]; if (h) await h(req, res, prox); };
    await prox();
    for (let k = 0; k < 200 && json === null; k++) await new Promise((r2) => setTimeout(r2, 5));
    return { status, json, ...m };
  }
  const R = 'src/routes/divisoes.js';
  const carteiras = () => [
    { id: 'cc', grupo_id: 'g', nome: 'Itaú Platinum', tipo: 'Crédito', saldo: 0 },
    { id: 'conta', grupo_id: 'g', nome: 'Itaú', tipo: 'Corrente', saldo: 1000, of_conta_id: null },
    { id: 'banco', grupo_id: 'g', nome: 'Nubank', tipo: 'Corrente', saldo: 500, of_conta_id: 'of1' },
    { id: 'outro', grupo_id: 'h', nome: 'De outro grupo', tipo: 'Corrente', saldo: 0 },
  ];
  const parcelas = () => Array.from({ length: 10 }, (_, i) => ({
    id: `p${i + 1}`, grupo_id: 'g', tipo: 'Gasto', categoria: 'Eletro', valor: 300, carteira_nome: 'Itaú Platinum',
    parcela_grupo: 'PG', parcela_num: i + 1, parcela_total: 10, dividida_com: null, parte_outro: null,
  }));

  let r = await chamar(R, 'put', '/transacao/:id', {
    params: { id: 'p1' }, body: { divisao: { com: 'Esposa', modo: 'metade' }, aplicar_parcelas: true },
    tabelas: { transacoes: parcelas(), wallets: carteiras() },
  });
  eq([r.status, r.json.atualizadas, r.tabelas.transacoes.filter((t) => t.dividida_com === 'Esposa' && t.parte_outro === 150).length],
    [200, 10, 10], '§2 metade em todas as 10 parcelas da geladeira');
  eq(r.log.filter((l) => l[0] === 'update').length, 1, '§2 mesma mudança nas 10: um update só (custo é o número de idas)');

  r = await chamar(R, 'put', '/transacao/:id', {
    params: { id: 'p1' }, body: { divisao: { com: 'Esposa', modo: 'metade' } },
    tabelas: { transacoes: parcelas(), wallets: carteiras() },
  });
  eq(r.tabelas.transacoes.filter((t) => t.dividida_com).map((t) => t.id), ['p1'], '§2 sem "aplicar nas parcelas": só a parcela tocada');

  const comOutraCompra = [...parcelas(), { id: 'x1', grupo_id: 'g', tipo: 'Gasto', valor: 300, carteira_nome: 'Outro cartão', parcela_grupo: 'PG', parcela_total: 10, parcela_num: 1 }];
  r = await chamar(R, 'put', '/transacao/:id', {
    params: { id: 'p1' }, body: { divisao: { com: 'Esposa', modo: 'metade' }, aplicar_parcelas: true },
    tabelas: { transacoes: comOutraCompra, wallets: carteiras() },
  });
  eq(r.tabelas.transacoes.find((t) => t.id === 'x1').dividida_com, undefined, '⚠️ §2 mesmo grupo de parcela em OUTRO cartão não é irmã');

  const divididas = parcelas().map((p) => ({ ...p, dividida_com: 'Esposa', parte_outro: 150 }));
  r = await chamar(R, 'put', '/transacao/:id', { params: { id: 'p3' }, body: { divisao: null, aplicar_parcelas: true }, tabelas: { transacoes: divididas, wallets: carteiras() } });
  eq([r.status, r.tabelas.transacoes.filter((t) => t.dividida_com).length], [200, 0], '§2 tirar a divisão de todas');

  r = await chamar(R, 'put', '/transacao/:id', { params: { id: 'p1' }, body: { divisao: { com: 'E', modo: 'valor', valor: 400 }, aplicar_parcelas: true }, tabelas: { transacoes: parcelas(), wallets: carteiras() } });
  eq([r.status, r.tabelas.transacoes.filter((t) => t.dividida_com).length], [400, 0], '⚠️ §2 parte maior que a parcela: 400 e nada gravado');

  const naConta = [{ id: 't1', grupo_id: 'g', tipo: 'Gasto', valor: 80, carteira_nome: 'Itaú' }];
  r = await chamar(R, 'put', '/transacao/:id', { params: { id: 't1' }, body: { divisao: { com: 'E', modo: 'metade' } }, tabelas: { transacoes: naConta, wallets: carteiras() } });
  eq([r.status, r.tabelas.transacoes[0].dividida_com], [400, undefined], '§2 compra na conta: 400');
  r = await chamar(R, 'put', '/transacao/:id', { params: { id: 'nao' }, body: { divisao: { com: 'E', modo: 'metade' } }, tabelas: { transacoes: [{ ...parcelas()[0], grupo_id: 'h' }], wallets: carteiras() } });
  eq(r.status, 404, '⚠️ §2 lançamento de outro grupo: 404');

  r = await chamar(R, 'put', '/transacao/:id', { params: { id: 'p1' }, body: { divisao: { com: 'E', modo: 'metade' }, aplicar_parcelas: true }, tabelas: { transacoes: parcelas(), wallets: carteiras() }, cfg: { sem206: true } });
  ok(r.status === 503 && r.json.codigo === 'sem_migracao' && !/column|relation|migration/i.test(r.json.erro), '§2 sem a 206: 503 sem jargão');

  r = await chamar(R, 'get', '/pessoas', { tabelas: { transacoes: [
    { grupo_id: 'g', dividida_com: 'Esposa' }, { grupo_id: 'g', dividida_com: 'ESPOSA ' }, { grupo_id: 'g', dividida_com: 'Pedro' },
    { grupo_id: 'h', dividida_com: 'De outro grupo' }, { grupo_id: 'g', dividida_com: null },
  ] } });
  eq(r.json, { pessoas: ['Esposa', 'Pedro'], liberado: true }, '§2 nomes já usados, sem repetir e só do grupo');
  r = await chamar(R, 'get', '/pessoas', { cfg: { sem206: true } });
  eq(r.json, { pessoas: [], liberado: false }, '§2 nomes sem a 206: vazio, avisando');

  r = await chamar(R, 'get', '/acertos', { query: { cartao_id: 'cc', competencia: '2026-11' }, tabelas: { divisoes_acertos: [
    { id: 'a1', grupo_id: 'g', cartao_id: 'cc', competencia: '2026-11', pessoa: 'Esposa', valor: 150 },
    { id: 'a2', grupo_id: 'g', cartao_id: 'cc', competencia: '2026-10', pessoa: 'Esposa', valor: 150 },
    { id: 'a3', grupo_id: 'h', cartao_id: 'cc', competencia: '2026-11', pessoa: 'Esposa', valor: 150 },
  ] } });
  eq(r.json.acertos.map((a) => a.id), ['a1'], '§2 acertos: só desta fatura e deste grupo');
  r = await chamar(R, 'get', '/acertos', { query: { cartao_id: 'cc', competencia: '2026-11' }, cfg: { sem206: true } });
  eq(r.json, { acertos: [], liberado: false }, '§2 acertos sem a 206: vazio, avisando');

  // ── POST /acertos ──
  const acertoBase = { cartao_id: 'cc', competencia: '2026-11', pessoa: 'Esposa', valor: 150 };
  r = await chamar(R, 'post', '/acertos', { body: { ...acertoBase, forma: 'conta', wallet_id: 'conta' }, tabelas: { wallets: carteiras(), transacoes: [], divisoes_acertos: [] } });
  const entrada = r.tabelas.transacoes[0];
  eq([r.status, entrada.tipo, entrada.transferencia, entrada.categoria, entrada.carteira_nome, entrada.valor],
    [200, 'Recebimento', true, 'Reembolso', 'Itaú', 150], '§2 "me mandou o dinheiro" (conta manual): entrada FORA das receitas');
  eq(r.tabelas.wallets.find((w) => w.id === 'conta').saldo, 1150, '§2 …e o saldo da conta sobe');
  eq([r.tabelas.divisoes_acertos.length, r.tabelas.divisoes_acertos[0].transacao_id, r.tabelas.divisoes_acertos[0].forma], [1, entrada.id, 'conta'], '§2 …e o acerto aponta a entrada');

  r = await chamar(R, 'post', '/acertos', { body: { ...acertoBase, forma: 'conta', wallet_id: 'banco' }, tabelas: { wallets: carteiras(), transacoes: [], divisoes_acertos: [] } });
  eq([r.status, r.json.codigo, r.tabelas.transacoes.length], [409, 'conta_do_banco', 0], '⚠️ §2 conta do BANCO: não lança entrada (o Pix chega pelo extrato)');
  r = await chamar(R, 'post', '/acertos', { body: { ...acertoBase, forma: 'conta', wallet_id: 'cc' }, tabelas: { wallets: carteiras(), transacoes: [], divisoes_acertos: [] } });
  eq(r.status, 400, '§2 entrada num cartão: 400');
  r = await chamar(R, 'post', '/acertos', { body: { ...acertoBase, cartao_id: 'conta', forma: 'registro' }, tabelas: { wallets: carteiras(), divisoes_acertos: [] } });
  eq(r.status, 400, '§2 acerto de "cartão" que é conta: 400');
  r = await chamar(R, 'post', '/acertos', { body: { ...acertoBase, forma: 'conta', wallet_id: 'conta' }, tabelas: { wallets: carteiras(), transacoes: [] }, cfg: { sem206: true } });
  eq([r.status, r.tabelas.transacoes.length, r.tabelas.wallets.find((w) => w.id === 'conta').saldo], [503, 0, 1000], '⚠️ §2 sem a 206: nada de dinheiro mexido');
  r = await chamar(R, 'post', '/acertos', {
    body: { ...acertoBase, forma: 'conta', wallet_id: 'conta' }, tabelas: { wallets: carteiras(), transacoes: [], divisoes_acertos: [] },
    cfg: { falhar: (nome, modo) => nome === 'divisoes_acertos' && modo === 'insert' },
  });
  eq([r.status, r.tabelas.transacoes.length, r.tabelas.wallets.find((w) => w.id === 'conta').saldo], [500, 0, 1000],
    '⚠️ §2 acerto não gravou: a entrada sai e o saldo volta ao que ERA (não desconta duas vezes)');

  const pix = () => [{ id: 'pix', grupo_id: 'g', tipo: 'Recebimento', valor: 1500, carteira_nome: 'Nubank', transferencia: false }];
  r = await chamar(R, 'post', '/acertos', { body: { ...acertoBase, valor: 1500, forma: 'vincular', transacao_id: 'pix' }, tabelas: { wallets: carteiras(), transacoes: pix(), divisoes_acertos: [] } });
  eq([r.status, r.tabelas.transacoes[0].transferencia, r.tabelas.wallets.find((w) => w.id === 'banco').saldo, r.tabelas.divisoes_acertos[0].transacao_id],
    [200, true, 500, 'pix'], '§2 ligar ao Pix que chegou: a entrada sai das receitas e o saldo não muda');
  r = await chamar(R, 'post', '/acertos', { body: { ...acertoBase, forma: 'vincular', transacao_id: 'pix' }, tabelas: { wallets: carteiras(), transacoes: pix(), divisoes_acertos: [{ id: 'z', transacao_id: 'pix', grupo_id: 'g' }] } });
  eq([r.status, r.tabelas.transacoes[0].transferencia], [409, false], '⚠️ §2 a mesma entrada não paga duas partes');
  r = await chamar(R, 'post', '/acertos', { body: { ...acertoBase, forma: 'vincular', transacao_id: 'pix' }, tabelas: { wallets: carteiras(), transacoes: [{ ...pix()[0], transferencia: true }], divisoes_acertos: [] } });
  eq(r.status, 409, '§2 entrada que já não é receita: 409 explicando');
  r = await chamar(R, 'post', '/acertos', { body: { ...acertoBase, forma: 'vincular', transacao_id: 'pix' }, tabelas: { wallets: carteiras(), transacoes: [{ ...pix()[0], grupo_id: 'h' }], divisoes_acertos: [] } });
  eq(r.status, 400, '⚠️ §2 entrada de outro grupo: recusa');
  r = await chamar(R, 'post', '/acertos', {
    body: { ...acertoBase, forma: 'vincular', transacao_id: 'pix' }, tabelas: { wallets: carteiras(), transacoes: pix(), divisoes_acertos: [] },
    cfg: { falhar: (nome, modo) => nome === 'divisoes_acertos' && modo === 'insert' },
  });
  eq([r.status, r.tabelas.transacoes[0].transferencia], [500, false], '§2 acerto não gravou: a entrada volta a ser receita');

  r = await chamar(R, 'post', '/acertos', { body: { ...acertoBase, forma: 'registro' }, tabelas: { wallets: carteiras(), transacoes: [], divisoes_acertos: [] } });
  eq([r.status, r.tabelas.divisoes_acertos.length, r.tabelas.transacoes.length], [200, 1, 0], '§2 "de outro jeito": só anota');

  r = await chamar(R, 'get', '/recebimentos', { query: { wallet_id: 'banco', esperado: '1500' }, tabelas: { wallets: carteiras(), transacoes: [
    ...pix().map((p) => ({ ...p, data: new Date().toISOString() })),
    { id: 'velho', grupo_id: 'g', tipo: 'Recebimento', valor: 1500, carteira_nome: 'Nubank', data: '2020-01-01' },
  ], divisoes_acertos: [] } });
  eq([r.status, r.json.recebimentos.map((x) => x.id), r.json.conta.banco], [200, ['pix'], true], '§2 entradas recentes da conta (45 dias)');
  r = await chamar(R, 'get', '/recebimentos', { query: { wallet_id: 'outro' }, tabelas: { wallets: carteiras() } });
  eq(r.status, 400, '⚠️ §2 conta de outro grupo: 400');

  // ── DELETE /acertos/:id ──
  const comAcertoConta = () => ({
    wallets: carteiras().map((w) => (w.id === 'conta' ? { ...w, saldo: 1150 } : w)),
    transacoes: [{ id: 'ent', grupo_id: 'g', tipo: 'Recebimento', valor: 150, carteira_nome: 'Itaú', pago: true, transferencia: true }],
    divisoes_acertos: [{ id: 'a1', grupo_id: 'g', forma: 'conta', transacao_id: 'ent', valor: 150 }],
  });
  r = await chamar(R, 'delete', '/acertos/:id', { params: { id: 'a1' }, tabelas: comAcertoConta() });
  eq([r.status, r.tabelas.transacoes.length, r.tabelas.divisoes_acertos.length, r.tabelas.wallets.find((w) => w.id === 'conta').saldo],
    [200, 0, 0, 1000], '§2 desfazer "me mandou": a entrada sai e o saldo volta');
  r = await chamar(R, 'delete', '/acertos/:id', { params: { id: 'a1' }, tabelas: {
    wallets: carteiras(), transacoes: [{ ...pix()[0], transferencia: true }],
    divisoes_acertos: [{ id: 'a1', grupo_id: 'g', forma: 'vincular', transacao_id: 'pix' }],
  } });
  eq([r.status, r.tabelas.transacoes[0].transferencia, r.tabelas.divisoes_acertos.length], [200, false, 0], '§2 desfazer a ligação: a entrada volta a ser receita');
  r = await chamar(R, 'delete', '/acertos/:id', { params: { id: 'a1' }, tabelas: {
    transacoes: [{ id: 'ext', grupo_id: 'g' }], divisoes_acertos: [{ id: 'a1', grupo_id: 'g', forma: 'fatura', transacao_id: 'ext' }],
  } });
  eq([r.status, r.tabelas.transacoes.length, r.tabelas.divisoes_acertos.length, !!r.json.aviso], [200, 1, 0, true],
    '⚠️ §2 desfazer o "pagou na fatura": só a marcação sai; o pagamento da fatura fica (e a tela avisa)');
  r = await chamar(R, 'delete', '/acertos/:id', { params: { id: 'a1' }, tabelas: { divisoes_acertos: [{ id: 'a1', grupo_id: 'h', forma: 'registro' }] } });
  eq([r.status, r.tabelas.divisoes_acertos.length], [404, 1], '⚠️ §2 acerto de outro grupo: 404');

  // ═══════════════════════════════════════════════════════════════════════
  console.log('── 3. criar já dividida e o Pagar fatura ──');
  const T = 'src/routes/transacoes.js';
  r = await chamar(T, 'post', '/parcelado', {
    body: { categoria: 'Eletro', observacao: 'Geladeira', carteira_nome: 'Itaú Platinum', valor_parcela: 300, num_parcelas: 10, data: '2026-11-20',
      divisao: { com: 'Esposa', modo: 'metade' } },
    tabelas: { wallets: carteiras(), transacoes: [], grupos: [{ id: 'g', moeda_base: 'BRL' }] },
  });
  eq([r.status, r.json.divisao_resultado && r.json.divisao_resultado.ok, r.tabelas.transacoes.filter((t) => t.parte_outro === 150 && t.dividida_com === 'Esposa').length],
    [200, true, 10], '§3 parcelada nasce dividida nas 10 parcelas');
  r = await chamar(T, 'post', '/parcelado', {
    body: { categoria: 'Eletro', observacao: 'Geladeira', carteira_nome: 'Itaú Platinum', valor_parcela: 300, num_parcelas: 10, data: '2026-11-20',
      divisao: { com: 'Esposa', modo: 'metade' } },
    tabelas: { wallets: carteiras(), transacoes: [], grupos: [{ id: 'g', moeda_base: 'BRL' }] }, cfg: { sem206: true },
  });
  eq([r.status, r.tabelas.transacoes.length, r.json.divisao_resultado && r.json.divisao_resultado.codigo], [200, 10, 'sem_migracao'],
    '⚠️ §3 sem a 206: a compra é lançada mesmo assim e a tela sabe que a divisão não foi');
  r = await chamar(T, 'post', '/parcelado', {
    body: { categoria: 'Eletro', observacao: 'Geladeira', carteira_nome: 'Itaú Platinum', valor_parcela: 300, num_parcelas: 2 },
    tabelas: { wallets: carteiras(), transacoes: [], grupos: [{ id: 'g', moeda_base: 'BRL' }] },
  });
  eq([r.status, r.json.divisao_resultado], [200, undefined], '§3 sem divisão pedida: resposta igual à de antes');

  const W = 'src/routes/wallets.js';
  r = await chamar(W, 'post', '/fatura/pagar', {
    body: { cartao_id: 'cc', competencia: '2026-11', pagamentos: [
      { wallet_id: 'conta', valor: 150 },
      { externa: true, descricao: 'Esposa', valor: 150, acerto_pessoa: 'Esposa' },
    ] },
    tabelas: { wallets: carteiras(), transacoes: [], pagamentos_fatura: [], divisoes_acertos: [], grupos: [{ id: 'g', moeda_base: 'BRL' }] },
  });
  const ac = (r.tabelas.divisoes_acertos || [])[0];
  eq([r.status, (r.tabelas.divisoes_acertos || []).length, ac && ac.forma, ac && ac.pessoa, ac && ac.valor, ac && ac.competencia],
    [200, 1, 'fatura', 'Esposa', 150, '2026-11'], '§3 Pagar fatura: a parte paga por fora vira o acerto dela');
  const ext = r.tabelas.transacoes.find((t) => t.id === (ac && ac.transacao_id));
  ok(!!ext && ext.carteira_nome == null, '§3 …ligado ao lançamento externo (sem conta)');
  r = await chamar(W, 'post', '/fatura/pagar', {
    body: { cartao_id: 'cc', competencia: '2026-11', pagamentos: [{ externa: true, descricao: 'Pai', valor: 50 }] },
    tabelas: { wallets: carteiras(), transacoes: [], pagamentos_fatura: [], divisoes_acertos: [], grupos: [{ id: 'g', moeda_base: 'BRL' }] },
  });
  eq((r.tabelas.divisoes_acertos || []).length, 0, '§3 pagamento por fora SEM divisão: nenhum acerto (como antes)');
  r = await chamar(W, 'post', '/fatura/pagar', {
    body: { cartao_id: 'cc', competencia: '2026-11', pagamentos: [{ externa: true, descricao: 'Esposa', valor: 150, acerto_pessoa: 'Esposa' }] },
    tabelas: { wallets: carteiras(), transacoes: [], pagamentos_fatura: [], grupos: [{ id: 'g', moeda_base: 'BRL' }] }, cfg: { sem206: true },
  });
  eq([r.status, r.tabelas.pagamentos_fatura.length], [200, 1], '⚠️ §3 sem a 206: o pagamento da fatura vale igual');

  console.log(`\n${total} verificações · ${falhas.length ? `${falhas.length} FALHAS` : 'todas ok'}`);
  if (falhas.length) { for (const f of falhas) console.log('  ✘ ' + f); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
