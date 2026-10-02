// =============================================================================
// EVAL DE ROTA — DELETE /api/wallets/fatura/pagamento/:id
//
// ⚠️ A FUNÇÃO PURA NÃO BASTA AQUI, e isso já custou caro neste projeto: em
// 30/09 eu validei uma regra com eval, dei por testado, e o CRON continuava
// quebrado porque nunca rodou. Aqui o risco é pior — mexe em saldo.
//
// Este arquivo chama o handler REAL da rota com um banco falso e confere o
// estado final: o saldo voltou ao valor de antes, a transação sumiu, o
// registro de pagamento sumiu. E, principalmente, que DOIS TOQUES não devolvem
// o saldo duas vezes.
//
// Rodar:  node evals/desfazerPagamentoRota.eval.js
// =============================================================================
const Module = require('module');
const path = require('path');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

/** Banco falso: tabelas em memória, com delete que devolve as linhas afetadas. */
function bancoFalso(estado, opts = {}) {
  return (tabela) => {
    const filtros = [];
    let acao = 'select';
    let patch = null;
    const q = {
      select() { return q; },
      eq(c, v) { filtros.push([c, v]); return q; },
      ilike(c, v) { filtros.push([c, String(v).toLowerCase()]); return q; },
      in() { return q; },
      order() { return q; },
      limit() { return q; },
      delete() { acao = 'delete'; return q; },
      update(p) { acao = 'update'; patch = p; return q; },
      maybeSingle() {
        const achado = aplicar()[0] ?? null;
        // Leitura atrasada: devolve a linha mesmo depois de apagada, pra
        // simular duas requisicoes que leram antes de qualquer delete.
        if (!achado && opts.leituraFantasma && opts.leituraFantasma.tabela === tabela) {
          return Promise.resolve({ data: { ...opts.leituraFantasma.linha }, error: null });
        }
        return Promise.resolve({ data: achado, error: null });
      },
      single() { return Promise.resolve({ data: aplicar()[0] ?? null, error: null }); },
      then(res) { return res({ data: aplicar(), error: null }); },
    };
    function casa(linha) {
      return filtros.every(([c, v]) => {
        const atual = linha[c];
        if (typeof atual === 'string' && typeof v === 'string') {
          return atual.toLowerCase() === v.toLowerCase();
        }
        return atual === v;
      });
    }
    function aplicar() {
      const linhas = estado[tabela] || [];
      const alvo = linhas.filter(casa);
      if (acao === 'delete') {
        estado[tabela] = linhas.filter((l) => !casa(l));
        return alvo;
      }
      if (acao === 'update') { for (const l of alvo) Object.assign(l, patch); return alvo; }
      return alvo;
    }
    return q;
  };
}

/** Monta o router com o banco falso e devolve o handler do DELETE. */
function carregarRota(estado, opts = {}) {
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) return { from: bancoFalso(estado, opts) };
    if (req.endsWith('middlewares/auth')) return (rq, rs, nx) => nx();
    if (req.endsWith('middlewares/permissao')) return { exigirPermissao: () => (rq, rs, nx) => nx() };
    return origLoad.call(this, req, parent, isMain);
  };
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  }
  const router = require(path.resolve(__dirname, '../src/routes/wallets.js'));
  Module._load = origLoad;

  const camada = router.stack.find(
    (c) => c.route?.path === '/fatura/pagamento/:id' && c.route?.methods?.delete,
  );
  if (!camada) throw new Error('rota DELETE /fatura/pagamento/:id não encontrada');
  // O último handler da pilha é o nosso.
  const pilha = camada.route.stack;
  return pilha[pilha.length - 1].handle;
}

async function chamar(handler, { id, grupoId = 'g1' }) {
  const req = { params: { id }, query: {}, body: {}, authUser: { id: 'u1', grupoAtivo: grupoId } };
  let corpo = null; let status = 200;
  const res = {
    status(s) { status = s; return res; },
    json(j) { corpo = j; return res; },
  };
  await handler(req, res);
  return { status, corpo };
}

function cenarioPadrao() {
  return {
    pagamentos_fatura: [
      { id: 'p1', grupo_id: 'g1', cartao_id: 'c1', competencia: '2026-10', valor: 565.18, transacao_id: 't1' },
    ],
    wallets: [
      { id: 'c1', grupo_id: 'g1', nome: 'Mercado pago Crédito', of_conta_id: null, saldo: 0 },
      { id: 'w1', grupo_id: 'g1', nome: 'Itaú', of_conta_id: null, saldo: 434.82 },
    ],
    transacoes: [
      { id: 't1', grupo_id: 'g1', valor: 565.18, carteira_nome: 'Itaú', categoria: '💳 Fatura' },
    ],
    fatura_rollover: [],
  };
}

(async () => {
  console.log('── 1. ⚠️ O SALDO VOLTA AO VALOR EXATO DE ANTES ──');
  {
    const estado = cenarioPadrao();
    // Antes do pagamento a conta tinha 1000: 1000 − 565,18 = 434,82.
    const handler = carregarRota(estado);
    const { corpo } = await chamar(handler, { id: 'p1' });

    eq(corpo.ok, true, '§1 a rota confirma');
    eq(corpo.saldoDevolvido, true, '§1 devolveu saldo');
    eq(estado.wallets.find((w) => w.id === 'w1').saldo, 1000, '⚠️ §1 o saldo voltou a 1000, exatamente');
    eq(estado.transacoes.length, 0, '§1 o lançamento foi apagado');
    eq(estado.pagamentos_fatura.length, 0, '§1 e o registro de pagamento também');
  }
  console.log('  ok');

  console.log('── 2. ⚠️ DOIS TOQUES NÃO CRIAM DINHEIRO ──');
  {
    const estado = cenarioPadrao();
    const handler = carregarRota(estado);
    await chamar(handler, { id: 'p1' });
    const saldoApos1 = estado.wallets.find((w) => w.id === 'w1').saldo;
    const r2 = await chamar(handler, { id: 'p1' });

    eq(saldoApos1, 1000, '§2 o primeiro toque devolveu');
    eq(estado.wallets.find((w) => w.id === 'w1').saldo, 1000,
      '⚠️ §2 O SEGUNDO TOQUE NÃO DEVOLVE DE NOVO');
    eq(r2.status, 404, '§2 e responde que não há mais o que desfazer');
  }
  console.log('  ok');

  console.log('── 2B. ⚠️ CORRIDA REAL: duas requisições que LERAM a mesma linha ──');
  {
    // O §2 cobre o toque repetido (a segunda leitura já não acha nada). A
    // corrida de verdade é outra: duas requisições simultâneas passam pela
    // LEITURA antes de qualquer uma apagar, e as duas chegam ao delete.
    //
    // Simulado deixando a leitura devolver a linha mesmo depois de apagada —
    // é exatamente o que uma réplica atrasada faria. Só o delete que REALMENTE
    // removeu pode devolver saldo; o outro tem de parar.
    const estado = cenarioPadrao();
    const copiaDaLinha = { ...estado.pagamentos_fatura[0] };
    const handler = carregarRota(estado, {
      // leitura "velha": sempre enxerga o pagamento
      leituraFantasma: { tabela: 'pagamentos_fatura', linha: copiaDaLinha },
    });

    await chamar(handler, { id: 'p1' });
    const depoisDoPrimeiro = estado.wallets.find((w) => w.id === 'w1').saldo;
    const r2 = await chamar(handler, { id: 'p1' });

    eq(depoisDoPrimeiro, 1000, '§2B o primeiro devolveu o saldo');
    eq(estado.wallets.find((w) => w.id === 'w1').saldo, 1000,
      '⚠️ §2B O SEGUNDO LEU A LINHA MAS NÃO DEVOLVEU DE NOVO');
    eq(r2.corpo.jaDesfeito, true, '§2B …e respondeu que já estava desfeito');
  }
  console.log('  ok');

  console.log('── 3. ⚠️ CARTÃO DO BANCO: RECUSA SEM MEXER EM NADA ──');
  {
    const estado = cenarioPadrao();
    estado.wallets.find((w) => w.id === 'c1').of_conta_id = 'of-123';
    const handler = carregarRota(estado);
    const { status, corpo } = await chamar(handler, { id: 'p1' });

    eq(status, 409, '§3 recusa com 409');
    eq(corpo.codigo, 'cartao_do_banco', '§3 com código próprio');
    eq(estado.pagamentos_fatura.length, 1, '⚠️ §3 o registro CONTINUA lá');
    eq(estado.transacoes.length, 1, '§3 o lançamento também');
    eq(estado.wallets.find((w) => w.id === 'w1').saldo, 434.82, '§3 e o saldo não foi tocado');
  }
  console.log('  ok');

  console.log('── 4. ⚠️ ROLLOVER JÁ ROLADO: RECUSA SEM MEXER EM NADA ──');
  {
    const estado = cenarioPadrao();
    estado.fatura_rollover.push({ id: 'r1', cartao_id: 'c1', competencia: '2026-10', status: 'rolado' });
    const handler = carregarRota(estado);
    const { status, corpo } = await chamar(handler, { id: 'p1' });

    eq(status, 409, '§4 recusa com 409');
    eq(corpo.codigo, 'rollover_feito', '§4 com código próprio');
    eq(estado.pagamentos_fatura.length, 1, '§4 nada foi apagado');
    eq(estado.wallets.find((w) => w.id === 'w1').saldo, 434.82, '§4 e o saldo não mudou');
  }
  console.log('  ok');

  console.log('── 5. ⚠️ PAGAMENTO DE OUTRO GRUPO NÃO É APAGÁVEL ──');
  {
    const estado = cenarioPadrao();
    const handler = carregarRota(estado);
    const { status } = await chamar(handler, { id: 'p1', grupoId: 'OUTRO' });

    eq(status, 404, '⚠️ §5 grupo diferente recebe 404');
    eq(estado.pagamentos_fatura.length, 1, '§5 e o registro alheio continua intacto');
    eq(estado.wallets.find((w) => w.id === 'w1').saldo, 434.82, '§5 sem tocar no saldo de ninguém');
  }
  console.log('  ok');

  console.log('── 6. conta de Open Finance: apaga o registro, NÃO devolve saldo ──');
  {
    const estado = cenarioPadrao();
    estado.wallets.find((w) => w.id === 'w1').of_conta_id = 'of-conta';
    const handler = carregarRota(estado);
    const { corpo } = await chamar(handler, { id: 'p1' });

    eq(corpo.ok, true, '§6 desfaz (o CARTÃO é manual)');
    eq(corpo.saldoDevolvido, false, '⚠️ §6 mas a conta é do banco: saldo intocado');
    eq(estado.wallets.find((w) => w.id === 'w1').saldo, 434.82, '§6 o saldo segue o do banco');
    eq(estado.pagamentos_fatura.length, 0, '§6 o registro sai');
  }
  console.log('  ok');

  console.log('');
  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ desfazerPagamentoRota: a rota devolve o saldo certo, uma vez só');
  process.exit(0);
})();
