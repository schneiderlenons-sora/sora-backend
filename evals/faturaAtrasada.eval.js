// =============================================================================
// EVAL — fatura ATRASADA do cartão manual + passar pra próxima por ESCOLHA.
//
// Relato (Fábio, 16/11/2026): C6 venceu 15/11 sem pagamento e a tela pulou pra
// fatura de dezembro como se novembro estivesse paga. Na investigação:
//   • `/faturas` calculava `vencida` e NENHUMA tela lia;
//   • o JOB 1L rolava o saldo sozinho em 24h — e quebrava com
//     `row is not defined` antes de avisar (100 rollovers silenciosos).
//
// Trava:
//   §1 situação da fatura (paga / atrasada / passada / em aberto)
//   §2 quais faturas estão atrasadas (o caso real do Fábio incluso)
//   §3 texto do aviso ("pagou parte" só quando pagou parte)
//   §4 juros
//   §5 rolarFatura com banco falso (reserva atômica, juros, desfazer)
//   §6 rota POST /fatura/rolar (escopo do grupo)
//   §7 JOB 1L de ponta a ponta (não rola sozinho, não morre no meio)
//
// Rodar:  npm run eval:fatura-atrasada
// =============================================================================
const path = require('path');
const Module = require('module');

const RAIZ = path.resolve(__dirname, '..');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'falso';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-falso';

const falhas = [];
let total = 0;
const eq = (a, b, m) => { total++; if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push(`${m}\n     esperado ${JSON.stringify(b)}\n     veio     ${JSON.stringify(a)}`); };

// Cartão REAL do relato: C6, fecha 9, vence 15, criado 20/09/2026.
const C6 = { id: 'c6', nome: 'C6 Bank', grupo_id: 'g1', dia_fechamento: 9, dia_vencimento: 15, of_conta_id: null };

// ── Banco falso, com estado ──────────────────────────────────────────────────
function bancoFalso({ txs = [], pagamentos = [], rollovers = [], falharInsertTx = false } = {}) {
  const estado = { txs: [...txs], pagamentos: [...pagamentos], rollovers: rollovers.map((r) => ({ ...r })), inseridas: [], apagadas: [], log: [] };
  let seq = 0;
  const from = (tabela) => {
    const q = { op: 'select', eqs: [], ins: [], payload: null, sel: false };
    const filtro = (r) => q.eqs.every(([c, v]) => r[c] === v) && q.ins.every(([c, vs]) => vs.includes(r[c]));
    const exec = () => {
      estado.log.push({ tabela, op: q.op, eqs: q.eqs, ins: q.ins, payload: q.payload });
      if (tabela === 'transacoes') {
        if (q.op === 'insert') {
          if (falharInsertTx && (falharInsertTx === true || q.payload.categoria === falharInsertTx)) return { data: null, error: { message: 'falha simulada' } };
          const linha = { id: `tx${++seq}`, ...q.payload };
          estado.inseridas.push(linha);
          return { data: { id: linha.id }, error: null };
        }
        if (q.op === 'delete') { const ids = (q.ins.find(([c]) => c === 'id') || [])[1] || []; estado.apagadas.push(...ids); return { data: null, error: null }; }
        return { data: estado.txs, error: null };
      }
      if (tabela === 'pagamentos_fatura') {
        return { data: estado.pagamentos.filter((p) => q.eqs.every(([c, v]) => p[c] === v)), error: null };
      }
      if (tabela === 'fatura_rollover') {
        if (q.op === 'insert') {
          const ja = estado.rollovers.find((r) => r.cartao_id === q.payload.cartao_id && r.competencia === q.payload.competencia);
          if (ja) return { data: null, error: { message: 'duplicate key' } };
          const linha = { id: `r${++seq}`, ...q.payload };
          estado.rollovers.push(linha);
          return { data: linha, error: null };
        }
        if (q.op === 'update') {
          const alvo = estado.rollovers.filter(filtro);
          alvo.forEach((r) => Object.assign(r, q.payload));
          return { data: q.sel ? alvo.map((r) => ({ id: r.id })) : null, error: null };
        }
        // CÓPIAS, como o banco de verdade: devolver o objeto guardado deixaria
        // um update posterior mudar a variável de quem leu antes.
        const achou = estado.rollovers.filter(filtro).map((r) => ({ ...r }));
        return { data: q.umSo ? (achou[0] || null) : achou, error: null };
      }
      if (tabela === 'wallets') {
        const ws = [C6, { ...C6, id: 'alheio', grupo_id: 'g2' }];
        const achou = ws.filter(filtro);
        return { data: q.umSo ? (achou[0] || null) : achou, error: null };
      }
      return { data: q.umSo ? null : [], error: null };
    };
    Object.assign(q, {
      select() { if (q.op !== 'select') q.sel = true; return q; },
      insert(p) { q.op = 'insert'; q.payload = p; return q; },
      update(p) { q.op = 'update'; q.payload = p; return q; },
      delete() { q.op = 'delete'; return q; },
      eq(c, v) { q.eqs.push([c, v]); return q; },
      in(c, vs) { q.ins.push([c, vs]); return q; },
      ilike() { return q; }, gte() { return q; }, lt() { return q; }, lte() { return q; },
      not() { return q; }, is() { return q; }, order() { return q; }, limit() { return q; },
      maybeSingle() { q.umSo = true; return Promise.resolve(exec()); },
      single() { q.umSo = true; return Promise.resolve(exec()); },
      then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
    });
    return q;
  };
  return { estado, cliente: { from } };
}

function carregarComBanco(banco, extras = {}) {
  const orig = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) return banco.cliente;
    if (extras[req]) return extras[req];
    for (const k of Object.keys(extras)) if (k.startsWith('*') && req.endsWith(k.slice(1))) return extras[k];
    return orig.call(this, req, parent, isMain);
  };
  for (const k of Object.keys(require.cache)) if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  return () => { Module._load = orig; };
}

// Compras do ciclo de novembro do C6 (10/10 a 09/11) — R$ 240,85, como no print.
const COMPRAS_NOV = [
  { valor: 82.90, tipo: 'Gasto', categoria: 'Supermercado', data: '2026-11-07T12:00:00Z' },
  { valor: 38.36, tipo: 'Gasto', categoria: 'Supermercado', data: '2026-10-20T12:00:00Z' },
  { valor: 79.90, tipo: 'Gasto', categoria: 'Barbeiro', data: '2026-10-25T12:00:00Z' },
  { valor: 39.69, tipo: 'Gasto', categoria: 'Combustível', data: '2026-10-30T12:00:00Z' },
];

(async () => {
  const fa = require(path.join(RAIZ, 'src/services/faturaAtrasada'));

  console.log('── 1. SITUAÇÃO DA FATURA ──');
  {
    const s = fa.situacaoDaFatura;
    eq(s({ venc: '2026-11-15', hoje: '2026-11-17', restante: 240.85 }), 'atrasada', '§1 venceu e não pagou');
    eq(s({ venc: '2026-11-15', hoje: '2026-11-15', restante: 240.85 }), 'em_aberto', '§1 NO dia do vencimento ainda não é atraso');
    eq(s({ venc: '2026-11-15', hoje: '2026-11-17', restante: 0 }), 'paga', '§1 paga');
    eq(s({ venc: '2026-11-15', hoje: '2026-11-17', restante: 0.005 }), 'paga', '§1 centavo de arredondamento não é dívida');
    eq(s({ venc: '2026-11-15', hoje: '2026-11-17', restante: 240.85, rolada: true }), 'rolada', '§1 passada pra frente não é atraso');
    eq(s({ venc: '2026-11-15', hoje: '2026-11-17', restante: 240.85, ehOF: true }), 'em_aberto', '§1 Open Finance nunca vira "atrasada" aqui');
  }

  console.log('── 2. QUAIS ESTÃO ATRASADAS ──');
  {
    const status = (mapa) => async (comp) => mapa[comp] || { fatura: 0, pago: 0, restante: 0 };
    // ⚠️ O CASO DO RELATO: novembro sem pagamento, outubro pago.
    const r = await fa.faturasAtrasadas(C6, {
      hoje: '2026-11-16', criadoEm: '2026-09-20',
      status: status({ '2026-11': { fatura: 240.85, pago: 0, restante: 240.85 }, '2026-10': { fatura: 94.9, pago: 94.9, restante: 0 } }),
    });
    eq(r.map((x) => x.competencia), ['2026-11'], '⚠️ §2 o Fábio vê novembro como atrasada');
    eq(r[0] && r[0].restante, 240.85, '§2 com o valor que falta');
    eq(r[0] && r[0].venc, '2026-11-15', '§2 e a data em que venceu');
    eq(r[0] && r[0].diasAtraso, 1, '§2 dias de atraso');

    // Antes de vencer: nada.
    const nov15 = await fa.faturasAtrasadas(C6, {
      hoje: '2026-11-15', criadoEm: '2026-09-20',
      status: status({ '2026-11': { fatura: 240.85, pago: 0, restante: 240.85 }, '2026-10': { fatura: 94.9, pago: 94.9, restante: 0 } }),
    });
    eq(nov15.map((x) => x.competencia), [], '§2 no dia do vencimento ainda não está atrasada');

    // Duas sem pagar: as duas aparecem, da mais recente pra mais antiga.
    const duas = await fa.faturasAtrasadas(C6, {
      hoje: '2026-11-16', criadoEm: '2026-08-01',
      status: status({
        '2026-11': { fatura: 240.85, pago: 0, restante: 240.85 },
        '2026-10': { fatura: 94.9, pago: 0, restante: 94.9 },
        '2026-09': { fatura: 50, pago: 50, restante: 0 },
      }),
    });
    eq(duas.map((x) => x.competencia), ['2026-11', '2026-10'], '§2 duas atrasadas, a mais recente primeiro; para na paga');

    // Passada pra frente encerra a busca (o saldo dela já está na seguinte).
    const rolou = await fa.faturasAtrasadas(C6, {
      hoje: '2026-11-16', criadoEm: '2026-08-01', roladas: new Set(['2026-10']),
      status: status({ '2026-11': { fatura: 335.75, pago: 0, restante: 335.75 }, '2026-10': { fatura: 94.9, pago: 0, restante: 94.9 } }),
    });
    eq(rolou.map((x) => x.competencia), ['2026-11'], '⚠️ §2 a passada pra frente NÃO conta de novo (seria cobrar duas vezes)');
    const rolouAtual = await fa.faturasAtrasadas(C6, {
      hoje: '2026-11-16', roladas: new Set(['2026-11']),
      status: status({ '2026-11': { fatura: 240.85, pago: 0, restante: 240.85 } }),
    });
    eq(rolouAtual, [], '§2 a própria fatura passada pra frente não é atrasada');

    // Histórico de antes de o cartão existir na Sora não é atraso.
    const antes = await fa.faturasAtrasadas(C6, {
      hoje: '2026-11-16', criadoEm: '2026-11-12',
      status: status({ '2026-11': { fatura: 240.85, pago: 0, restante: 240.85 } }),
    });
    eq(antes, [], '§2 ciclo que terminou antes de o cartão ser criado não conta');

    // Teto de ciclos.
    let chamadas = 0;
    const sempre = await fa.faturasAtrasadas(C6, { hoje: '2026-11-16', status: async () => { chamadas++; return { fatura: 10, pago: 0, restante: 10 }; } });
    eq([sempre.length, chamadas], [6, 6], '§2 no máximo 6 faturas pra trás');

    // Quem paga em dia: UMA leitura.
    chamadas = 0;
    await fa.faturasAtrasadas(C6, { hoje: '2026-11-16', status: async () => { chamadas++; return { fatura: 10, pago: 10, restante: 0 }; } });
    eq(chamadas, 1, '§2 quem paga em dia custa uma leitura só');

    eq(await fa.faturasAtrasadas({ ...C6, of_conta_id: 'x' }, { hoje: '2026-11-16', status: async () => ({ restante: 99 }) }), [], '§2 Open Finance fica de fora');
    eq(await fa.faturasAtrasadas({ ...C6, dia_vencimento: null }, { hoje: '2026-11-16', status: async () => ({ restante: 99 }) }), [], '§2 sem dia de vencimento não há atraso');
  }

  console.log('── 3. TEXTO DO AVISO ──');
  {
    const fmt = (v) => `R$ ${v.toFixed(2).replace('.', ',')}`;
    const nada = fa.textoAvisoAtraso({ cartaoNome: 'C6 Bank', competencia: '2026-11', venc: '2026-11-15', pago: 0, restante: 240.85, fmt });
    eq((nada.texto + nada.core).includes('Você pagou R$'), false, '⚠️ §3 quem não pagou nada NÃO lê "você pagou"');
    eq(nada.texto.includes('venceu em 15/11') && nada.texto.includes('R$ 240,85'), true, '§3 diz quando venceu e quanto');
    eq(nada.texto.includes('novembro'), true, '§3 diz QUAL fatura');
    eq(/automaticamente|sozinho/i.test(nada.texto + nada.core), false, '⚠️ §3 não promete rolar sozinho');
    eq(/[\r\n\t]/.test(nada.core), false, '§3 core em linha única (a Meta recusa quebra de linha)');
    const parte = fa.textoAvisoAtraso({ cartaoNome: 'C6 Bank', competencia: '2026-11', venc: '2026-11-15', pago: 100, restante: 140.85, fmt });
    eq(parte.texto.includes('Você pagou R$ 100,00'), true, '§3 pagamento parcial é dito');
    eq(/[\r\n\t]/.test(parte.core), false, '§3 core parcial em linha única');
  }

  console.log('── 4. JUROS ──');
  {
    eq(fa.validarJuros(undefined), { ok: true, valor: 0 }, '§4 sem juros');
    eq(fa.validarJuros(''), { ok: true, valor: 0 }, '§4 vazio = sem juros');
    eq(fa.validarJuros(12.345), { ok: true, valor: 12.35 }, '§4 arredonda no centavo');
    eq(fa.validarJuros(-1).ok, false, '§4 negativo não');
    eq(fa.validarJuros('abc').ok, false, '§4 texto não');
  }

  console.log('── 5. PASSAR PRA PRÓXIMA (rolarFatura) ──');
  {
    const rodar = async (cfg, args) => {
      const banco = bancoFalso(cfg);
      const restaura = carregarComBanco(banco);
      try {
        const { rolarFatura } = require(path.join(RAIZ, 'src/services/faturaRollover'));
        const r = await rolarFatura({ grupoId: 'g1', cartao: C6, competencia: '2026-11', hoje: '2026-11-17', userId: 'u1', ...args });
        return { r, estado: banco.estado };
      } finally { restaura(); }
    };

    const ok = await rodar({ txs: COMPRAS_NOV }, { juros: 12.5 });
    eq(ok.r.ok, true, '§5 passa');
    eq(ok.r.valor, 240.85, '§5 valor RECALCULADO na hora (não o gravado no aviso)');
    const principal = ok.estado.inseridas.find((t) => t.categoria === 'Fatura anterior');
    eq(principal && [principal.valor, principal.transferencia, principal.carteira_nome], [240.85, true, 'C6 Bank'], '§5 saldo vai pro cartão, fora dos relatórios');
    eq(principal && principal.data.slice(0, 10), '2026-11-10', '§5 no INÍCIO do ciclo seguinte (fatura de dezembro)');
    eq(ok.r.competenciaDestino, '2026-12', '§5 destino = dezembro');
    const juros = ok.estado.inseridas.find((t) => t.categoria === 'Juros');
    eq(juros && [juros.valor, juros.transferencia, juros.tipo], [12.5, false, 'Gasto'], '⚠️ §5 juros viram GASTO de verdade (entram nos relatórios)');
    eq(ok.estado.rollovers[0] && ok.estado.rollovers[0].status, 'rolado', '§5 marca rolada');
    const claim = ok.estado.log.find((l) => l.tabela === 'fatura_rollover' && l.op === 'update' && l.payload.status === 'rolado');
    eq(!!(claim && claim.ins.some(([c, v]) => c === 'status' && v.includes('aguardando'))), true, '⚠️ §5 a reserva é CONDICIONAL (aguardando → rolado)');

    const semJuros = await rodar({ txs: COMPRAS_NOV }, {});
    eq(semJuros.estado.inseridas.map((t) => t.categoria), ['Fatura anterior'], '§5 sem juros = um lançamento só');

    // Outro toque já reservou: nada é lançado de novo.
    const duplo = await rodar({ txs: COMPRAS_NOV, rollovers: [{ id: 'rx', cartao_id: 'c6', competencia: '2026-11', status: 'rolado', valor: 240.85 }] }, {});
    eq([duplo.r.jaRolado, duplo.estado.inseridas.length], [true, 0], '⚠️ §5 segundo toque não lança de novo');

    // Linha 'aguardando' (o aviso do job) é aproveitada.
    const doAviso = await rodar({ txs: COMPRAS_NOV, rollovers: [{ id: 'ra', cartao_id: 'c6', competencia: '2026-11', status: 'aguardando', valor: 999 }] }, {});
    eq([doAviso.r.ok, doAviso.r.valor, doAviso.estado.rollovers.length], [true, 240.85, 1], '§5 usa a linha do aviso, com o valor de AGORA');

    const naoVenceu = await rodar({ txs: COMPRAS_NOV }, { hoje: '2026-11-15' });
    eq(doAviso.estado.inseridas.map((t) => t.valor), [240.85], '⚠️ §5 o LANÇADO é o valor de agora, não o 999 gravado no aviso');
    eq(naoVenceu.r.codigo, 'nao_vencida', '§5 fatura que não venceu não passa');
    const paga = await rodar({ txs: COMPRAS_NOV, pagamentos: [{ cartao_id: 'c6', competencia: '2026-11', valor: 240.85 }] }, {});
    eq([paga.r.codigo, paga.estado.inseridas.length], ['quitada', 0], '§5 fatura paga não passa');
    const of = await rodar({ txs: COMPRAS_NOV }, { cartao: { ...C6, of_conta_id: 'x' } });
    eq(of.r.codigo, 'open_finance', '§5 Open Finance não passa (o banco faz isso)');
    const jurosRuim = await rodar({ txs: COMPRAS_NOV }, { juros: -3 });
    eq([jurosRuim.r.codigo, jurosRuim.estado.inseridas.length], ['juros', 0], '§5 juros inválido não lança nada');

    // Falha no lançamento dos juros: desfaz o principal e devolve a reserva.
    let erro = null;
    const banco = bancoFalso({ txs: COMPRAS_NOV, falharInsertTx: 'Juros' });
    const restaura = carregarComBanco(banco);
    try {
      const { rolarFatura } = require(path.join(RAIZ, 'src/services/faturaRollover'));
      await rolarFatura({ grupoId: 'g1', cartao: C6, competencia: '2026-11', hoje: '2026-11-17', juros: 10 });
    } catch (e) { erro = e; } finally { restaura(); }
    eq(!!erro, true, '§5 falha no lançamento sobe');
    eq(banco.estado.inseridas.length, 1, '§5 o principal tinha entrado antes da falha');
    eq(banco.estado.apagadas, banco.estado.inseridas.map((t) => t.id), '⚠️ §5 o que entrou é apagado');
    eq(banco.estado.rollovers[0].status, 'aguardando', '⚠️ §5 a fatura volta a ser atrasada (reserva devolvida)');
  }

  console.log('── 6. ROTA POST /fatura/rolar ──');
  {
    const banco = bancoFalso({ txs: COMPRAS_NOV });
    const restaura = carregarComBanco(banco, {
      '*middlewares/auth': (req, res, next) => { req.authUser = { grupoAtivo: 'g1' }; req.grupoId = 'g1'; req.userId = 'u1'; next(); },
      '*middlewares/permissao': { exigirPermissao: () => (req, res, next) => next() },
    });
    const RealDate = Date;
    const AGORA = new RealDate('2026-11-17T15:00:00Z');
    global.Date = class extends RealDate { constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(AGORA); } static now() { return AGORA.getTime(); } };
    global.Date.UTC = RealDate.UTC; global.Date.parse = RealDate.parse;
    try {
      const router = require(path.join(RAIZ, 'src/routes/wallets'));
      const camada = router.stack.find((l) => l.route && l.route.path === '/fatura/rolar' && l.route.methods.post);
      const chamar = (body) => new Promise((resolve) => {
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { resolve({ status: this.statusCode, body: d }); } };
        const req = { body, params: {}, query: {} };
        const fns = camada.route.stack.map((s) => s.handle);
        let i = 0; const next = () => { const fn = fns[i++]; if (fn) fn(req, res, next); };
        next();
      });
      const alheio = await chamar({ cartao_id: 'alheio', competencia: '2026-11' });
      eq(alheio.status, 404, '⚠️ §6 cartão de outro grupo: 404');
      const ok = await chamar({ cartao_id: 'c6', competencia: '2026-11', juros: 5 });
      eq([ok.status, ok.body.ok, ok.body.valor, ok.body.juros], [200, true, 240.85, 5], '§6 passa com juros');
      const de_novo = await chamar({ cartao_id: 'c6', competencia: '2026-11' });
      eq([de_novo.status, de_novo.body.jaRolado], [200, true], '§6 segunda vez: já passada');
      const sem = await chamar({ competencia: '2026-11' });
      eq(sem.status, 400, '§6 sem cartão: 400');
    } finally { global.Date = RealDate; restaura(); }
  }

  console.log('── 7. JOB 1L DE PONTA A PONTA ──');
  {
    const rodarJob = async ({ cartoes, rollovers = [], txs = [], quebrarCartao = null, instante = '2026-11-17T09:00:00Z' }) => {
      const banco = bancoFalso({ txs, rollovers });
      const enviados = [];
      const pendentes = [];
      const from0 = banco.cliente.from;
      banco.cliente.from = (t) => {
        const q = from0(t);
        if (t === 'wallets') {
          const orig = q.then.bind(q);
          q.then = (res, rej) => (q.op === 'select' && !q.umSo ? Promise.resolve({ data: cartoes, error: null }).then(res, rej) : orig(res, rej));
        }
        if (t === 'grupos') q.maybeSingle = () => Promise.resolve({ data: { dono_id: 'u1' }, error: null });
        if (t === 'users') q.maybeSingle = () => Promise.resolve({ data: { phone: '5511999999999', avisos_ativos: true }, error: null });
        if (t === 'fatura_rollover' && quebrarCartao) {
          const ms = q.maybeSingle;
          q.maybeSingle = () => (q.eqs.some(([c, v]) => c === 'cartao_id' && v === quebrarCartao) ? Promise.reject(new Error('falha simulada')) : ms());
        }
        return q;
      };
      const jobs = [];
      const restaura = carregarComBanco(banco, {
        'node-cron': { schedule: (e, fn) => { if (/fatura atrasada/.test(String(fn))) jobs.push(fn); return { stop() {} }; } },
        '*services/proativo': {
          provedor: () => 'zapi',
          enviarProativo: async (phone, o) => { enviados.push({ phone, ...o }); return true; },
          enviarProativoDetalhado: async (phone, o) => { enviados.push({ phone, ...o }); return { ok: true }; },
        },
        '*services/mensageiro': new Proxy({}, { get: () => async () => true }),
        '*services/pendentes': { criarPendente: async (p) => { pendentes.push(p); } },
      });
      const RealDate = Date;
      const AGORA = new RealDate(instante);
      global.Date = class extends RealDate { constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(AGORA); } static now() { return AGORA.getTime(); } };
      global.Date.UTC = RealDate.UTC; global.Date.parse = RealDate.parse;
      const antes = process.cwd(); process.chdir(RAIZ);
      const [w, e, l] = [console.warn, console.error, console.log];
      const avisos = [];
      try {
        require(path.join(RAIZ, 'src/jobs/index.js'));
        if (!jobs.length) throw new Error('JOB 1L não encontrado');
        console.warn = (...a) => avisos.push(a.join(' ')); console.error = () => {}; console.log = () => {};
        for (const fn of jobs) await fn();
      } finally {
        console.warn = w; console.error = e; console.log = l;
        global.Date = RealDate; process.chdir(antes); restaura();
      }
      return { enviados, pendentes, estado: banco.estado, avisos };
    };

    // ⚠️ O ROLLOVER 'aguardando' COM PRAZO VENCIDO NÃO É MAIS ROLADO SOZINHO.
    const r1 = await rodarJob({
      cartoes: [C6],
      rollovers: [{ id: 'ra', cartao_id: 'c6', competencia: '2026-11', status: 'aguardando', valor: 240.85, confirmar_ate: '2026-11-16T09:00:00Z', grupo_id: 'g1' }],
      txs: COMPRAS_NOV,
    });
    eq(r1.estado.inseridas.length, 0, '⚠️ §7 NADA é rolado sozinho (era o passo B)');
    eq(r1.estado.rollovers[0].status, 'aguardando', '§7 a fatura continua atrasada até a pessoa decidir');
    eq(r1.enviados.length, 0, '§7 e já avisada não é avisada de novo');

    // Aviso novo: sai, com o texto certo, e cria a pergunta.
    const r2 = await rodarJob({ cartoes: [C6], txs: COMPRAS_NOV });
    eq(r2.enviados.length, 1, '⚠️ §7 o aviso SAI (antes quebrava com "row is not defined")');
    const txt = String(r2.enviados[0] && r2.enviados[0].texto || '');
    eq(txt.includes('Você pagou R$'), false, '§7 não diz "você pagou" pra quem não pagou');
    eq(txt.includes('passar'), true, '§7 ensina a responder "passar"');
    eq(r2.pendentes.length === 1 && r2.pendentes[0].tipoPergunta, 'rolar_fatura', '§7 cria a pergunta no WhatsApp');
    eq(r2.estado.rollovers.length === 1 && r2.estado.rollovers[0].status, 'aguardando', '§7 grava a marca de "avisado"');
    eq(r2.estado.inseridas.length, 0, '§7 e não lança nada');
    eq(r2.avisos.some((a) => /row is not defined/.test(a)), false, '⚠️ §7 sem o ReferenceError');

    // Um cartão quebrado não impede o aviso do outro.
    const outro = { ...C6, id: 'c6b', nome: 'Outro' };
    const r3 = await rodarJob({ cartoes: [{ ...C6, id: 'quebra', nome: 'Quebra' }, outro], txs: COMPRAS_NOV, quebrarCartao: 'quebra' });
    eq(r3.enviados.length, 1, '⚠️ §7 um cartão com erro não derruba o aviso dos outros');

    // Fatura paga: nada.
    const r4 = await rodarJob({ cartoes: [C6], txs: [] });
    eq(r4.enviados.length + r4.estado.rollovers.length, 0, '§7 fatura sem saldo: nada');

    // ⚠️ Estoque antigo NÃO vira rajada de WhatsApp: só avisa até 3 dias depois
    // do vencimento. (Novembro do C6 venceu 15/11; dia 18 ainda avisa, dia 19 não.)
    const r5 = await rodarJob({ cartoes: [C6], txs: COMPRAS_NOV, instante: '2026-11-18T09:00:00Z' });
    eq(r5.enviados.length, 1, '§7 3 dias depois do vencimento ainda avisa');
    const r6 = await rodarJob({ cartoes: [C6], txs: COMPRAS_NOV, instante: '2026-11-19T09:00:00Z' });
    eq([r6.enviados.length, r6.estado.rollovers.length], [0, 0], '⚠️ §7 vencida há mais de 3 dias: sem aviso (fica no painel)');
  }

  console.log(`\n${total - falhas.length}/${total} ok`);
  if (falhas.length) { console.log('\nFALHAS:\n - ' + falhas.join('\n - ')); process.exit(1); }
  console.log('✓ faturaAtrasada');
  process.exit(0);
})();
