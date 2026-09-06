// =============================================================================
// EVAL do "a pagar no cartão" das mensagens do WhatsApp (`resumo` e `saldos`).
//
// POR QUE EXISTE: as duas mensagens somavam `−wallets.saldo` por conta própria.
// Medido na base em 06/09/2026, com a regra nova rodando em cima dos dados
// reais: dos **69 grupos com cartão, 40 mudam de valor** — 23 tinham a dívida
// INFLADA (um deles em R$ 178.081,36) e 17 tinham dívida ESCONDIDA.
//
// O relato que abriu o caso: o zap dizia "a pagar R$ 3.663,42 · saldo real
// −R$ 2.286,49" no mesmo minuto em que o painel mostrava R$ 1.041,05 de
// fatura. Depois: a pagar R$ 1.061,45 · saldo real +R$ 315,48.
//
// Erro aqui não estoura — sai um número plausível e errado sobre DÍVIDA, que é
// o que o usuário usa pra decidir se pode gastar.
//
// Rodar:  npm run eval:a-pagar-cartoes
// =============================================================================
const { aPagarCartoes, avisoParcial } = require('../src/services/aPagarCartoes');

const falhas = [];
const eq = (a, b, m) => {
  if (a === b) return;
  falhas.push(`${m}\n      esperado: ${JSON.stringify(b)}\n      recebido: ${JSON.stringify(a)}`);
};

// Injeta a vista do cartão por id, no lugar da ida ao banco.
const comVistas = (mapa) => ({
  vistaDoCartao: async (_g, c) => {
    if (!(c.id in mapa)) throw new Error('sem fatura');
    return mapa[c.id];
  },
});

const cartao = (id, nome, saldo, extra = {}) => ({ id, nome, saldo, tipo: 'Crédito', ...extra });
const conta  = (id, nome, saldo) => ({ id, nome, saldo, tipo: 'Conta' });

(async () => {
  // ── 1. O DEFEITO Nº 1: `−saldo` não desconta o que já foi pago ────────────
  //
  // Números REAIS do cartão que gerou o relato: fatura publicada pelo banco
  // R$ 3.895,75, com R$ 2.854,70 já pagos. O saldo da carteira guarda a fatura
  // BRUTA, então a regra antiga cobrava de novo o que a pessoa acabou de pagar.
  console.log('── 1. pagamento já feito não pode pesar ──');
  {
    const ws = [cartao('mp', 'Mercado Pago (OF)', -3496.13)];
    const r = await aPagarCartoes('g', ws, {}, comVistas({ mp: 1041.05 }));
    eq(r.total, 1041.05, 'usa o restante (fatura − pagamentos), não o −saldo');
    eq(-ws[0].saldo, 3496.13, 'e o −saldo continua sendo o número ERRADO que se usava');
  }
  console.log('  ok');

  // ── 2. O DEFEITO Nº 2: no cartão MANUAL, `saldo` é acumulado ─────────────
  //
  // O Itaú do relato fecha dia 21. O ciclo em curso tinha R$ 20,40, mas o saldo
  // carregava R$ 167,29 de ciclos anteriores. Somar isso responde "quanto devo
  // desde sempre", não "quanto vou pagar agora".
  console.log('── 2. cartão manual: fatura do CICLO, não o acumulado ──');
  {
    const r = await aPagarCartoes('g', [cartao('itau', 'Itaú Crédito', -167.29)], {},
      comVistas({ itau: 20.40 }));
    eq(r.total, 20.40, 'o ciclo em curso, não o saldo histórico');
  }
  console.log('  ok');

  // ── 3. Os dois juntos: o caso do relato, ponta a ponta ───────────────────
  console.log('── 3. o caso do relato ──');
  {
    const ws = [
      conta('c1', 'Mercado Pago', 1373.34), conta('c2', 'Inter', 3.59), conta('c3', 'Dinheiro', 0),
      cartao('itau', 'Itaú Crédito', -167.29), cartao('mp', 'Mercado Pago (OF)', -3496.13),
    ];
    const r = await aPagarCartoes('g', ws, {}, comVistas({ itau: 20.40, mp: 1041.05 }));
    eq(r.total, 1061.45, 'a pagar');
    eq(Number((1376.93 - r.total).toFixed(2)), 315.48, 'saldo real (o zap dizia −2286.49)');
    eq(r.porCartao.length, 2, 'só os cartões entram na lista');
  }
  console.log('  ok');

  // ── 4. ⚠️ SALDO POSITIVO NUM CARTÃO ESCONDIA A FATURA INTEIRA ────────────
  //
  // A regra antiga era `aPagar = saldoCard < 0 ? −saldoCard : 0`: com a soma
  // dos cartões positiva (estorno, crédito, saldo mal ajustado), ela mostrava
  // ZERO e a linha do cartão sumia da mensagem. Medido: 1 grupo da base tinha
  // −R$ 641,66 "a pagar" e uma fatura real de R$ 2.305,12 invisível.
  console.log('── 4. saldo positivo não pode zerar a fatura ──');
  {
    const ws = [cartao('a', 'Cartão A', 900.00), cartao('b', 'Cartão B', -258.34)];
    const antigo = (() => { const s = 900.00 - 258.34; return s < 0 ? -s : 0; })();
    eq(antigo, 0, 'a regra ANTIGA dizia que não havia nada a pagar');
    const r = await aPagarCartoes('g', ws, {}, comVistas({ a: 1500.00, b: 805.12 }));
    eq(r.total, 2305.12, 'a nova soma a fatura de cada cartão, uma a uma');
  }
  console.log('  ok');

  // ── 5. Falhar não é somar zero ───────────────────────────────────────────
  //
  // ⚠️ Engolir o erro e contar 0 ESCONDE DÍVIDA — o modo de falha exato que
  // este arquivo existe pra acabar. Cartão que não dá pra calcular sai da soma
  // E o total se declara parcial.
  console.log('── 5. cartão sem fatura vira aviso, não zero ──');
  {
    const r = await aPagarCartoes('g', [cartao('ok', 'OK', -100), cartao('x', 'Quebrado', -9999)],
      {}, comVistas({ ok: 100 }));
    eq(r.total, 100, 'só o que deu pra calcular entra');
    eq(r.semFatura, 1, 'e o que não deu é contado');
    eq(avisoParcial(r), '\n⚠️ Total parcial: 1 cartão(ões) sem fatura calculada.', 'a mensagem avisa');
    eq(avisoParcial({ semCambio: 0, semFatura: 0 }), '', 'sem problema, sem aviso');
  }
  console.log('  ok');

  // ── 6. Câmbio (migration 144) ────────────────────────────────────────────
  //
  // Hoje não há NENHUM cartão em moeda estrangeira na base, mas o caminho
  // existe e some se ninguém o testar. Sem cotação, a carteira sai da soma e é
  // contada — nunca convertida a 1:1, que somaria dólar como real.
  console.log('── 6. moeda estrangeira ──');
  {
    const ws = [cartao('br', 'BR', -50, { moeda: 'BRL' }), cartao('us', 'US', -10, { moeda: 'USD' })];
    const semTaxa = await aPagarCartoes('g', ws, {}, comVistas({ br: 50, us: 10 }));
    eq(semTaxa.total, 50, 'sem cotação, o cartão em USD fica de fora');
    eq(semTaxa.semCambio, 1, 'e é contado como faltante');
    const comTaxa = await aPagarCartoes('g', ws, { USD: 5 }, comVistas({ br: 50, us: 10 }));
    eq(comTaxa.total, 100, 'com cotação, 10 USD × 5 = 50 entram');
  }
  console.log('  ok');

  // ── 7. Bordas ────────────────────────────────────────────────────────────
  console.log('── 7. bordas ──');
  {
    eq((await aPagarCartoes('g', [], {}, comVistas({}))).total, 0, 'grupo sem carteira');
    eq((await aPagarCartoes('g', [conta('c', 'Conta', 500)], {}, comVistas({}))).total, 0,
      'conta comum nunca entra no "a pagar"');
    const quitado = await aPagarCartoes('g', [cartao('q', 'Quitado', -800)], {}, comVistas({ q: 0 }));
    eq(quitado.total, 0, 'fatura quitada some da conta mesmo com saldo de R$ 800');
    eq(quitado.semFatura, 0, 'zero calculado não é zero por falha');
  }
  console.log('  ok');

  console.log('');
  if (falhas.length) {
    console.error(`❌ ${falhas.length} falha(s):`);
    falhas.slice(0, 10).forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✅ a pagar no cartão: todos os casos passaram');
})();
