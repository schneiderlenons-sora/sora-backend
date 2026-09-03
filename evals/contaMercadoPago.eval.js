// =============================================================================
// eval:conta-mercado-pago — "mercado" é o SUPERMERCADO, "mercado pago" é a CONTA
//
// Regra pedida pelo usuário (03/09/2026), palavras dele: *"a Sora deveria
// interpretar a conta Mercado Pago apenas se o 'pago' vier depois do mercado.
// Se o usuário disser apenas 'mercado' ele não está se referindo à conta, e sim
// ao supermercado."*
//
// O comportamento JÁ era esse — este eval existe pra ele não se perder sem
// ninguém notar. Ele depende de duas coisas que parecem inofensivas de mexer:
//
//   1. `temPalavra` exige o nome INTEIRO da carteira como sequência de palavras.
//      Trocar por "contém alguma palavra do nome" faria "no mercado" casar com
//      "Mercado Pago" — e o gasto do supermercado iria pra conta errada.
//   2. O limiar do fuzzy é 0.8. A similaridade entre "mercado" e "mercado pago"
//      é 0.58 — é exatamente essa folga que os separa. Baixar o limiar pra
//      ~0.55 juntaria os dois.
//
// ⚠️ E é DE MÃO DUPLA: a conta "Mercado Pago" também não pode fazer o gasto cair
// na categoria Mercado (supermercado). Quem cuida disso é o
// `limparReferenciaConta`, e o caso está aqui embaixo.
// =============================================================================
const { resolverCarteiraReal, detectarContaNoTexto } = require('../src/handlers/transacoes');
const { interpretarRapido } = require('../src/handlers/interpretador');

let falhas = 0;
const ok = (cond, nome, extra) => {
  if (cond) { console.log(`  ok ${nome}`); return; }
  falhas++; console.log(`  XX ${nome}${extra ? ` — ${extra}` : ''}`);
};
const eq = (a, b, nome) => ok(a === b, nome, `veio ${JSON.stringify(a)}, esperado ${JSON.stringify(b)}`);

// Carteiras da conta do relato — inclui as DUAS "Mercado Pago", que é o caso
// mais fácil de um match frouxo confundir.
const CARTEIRAS = [
  { id: '1', nome: 'Inter',             tipo: 'Corrente' },
  { id: '2', nome: 'Dinheiro',          tipo: 'Dinheiro' },
  { id: '3', nome: 'Itaú Crédito',      tipo: 'Crédito'  },
  { id: '4', nome: 'Mercado Pago',      tipo: 'Corrente' },
  { id: '5', nome: 'Mercado Pago (OF)', tipo: 'Corrente' },
];

// ⚠️ AS CONTAS SÃO INJETADAS pelo 3º argumento, não por stub do export.
//
// A primeira versão deste eval trocava `module.exports.listarContasAtivas` por
// um stub — e não funcionou: as duas funções chamam a `listarContasAtivas` do
// escopo do MÓDULO, que a troca no export não religa. O efeito foi pior que
// falhar: as consultas iam ao banco com um grupo inexistente, voltavam `null`,
// e a seção 1 ("mercado" não resolve) PASSAVA POR MOTIVO ERRADO — null nunca é
// "Mercado Pago". Teste que passa por acidente é pior que teste que falha.
//
// Daí o 3º parâmetro opcional (`contasInjetadas`) nas duas: em produção elas
// seguem indo ao banco; aqui recebem a lista e nada é consultado.
const inj = (t) => resolverCarteiraReal('g1', t, CARTEIRAS);
const injTexto = (f) => detectarContaNoTexto('g1', f, CARTEIRAS);

(async () => {
  console.log('carteiras: ' + CARTEIRAS.map((c) => c.nome).join(' | ') + '\n');

  console.log('── 1. "mercado" NUNCA é a conta Mercado Pago ──');
  for (const t of ['mercado', 'no mercado', 'supermercado', 'mercadinho']) {
    const r = await inj(t);
    ok(!/mercado pago/i.test(String(r || '')), `"${t}" não resolve pra Mercado Pago`, `veio ${r}`);
  }
  // ⚠️ E também não pode achar a conta varrendo a FRASE inteira.
  for (const f of ['gastei 50 no mercado', 'comprei 30 de pao no mercado', 'gastei 120 no supermercado']) {
    const r = await injTexto(f);
    ok(!/mercado pago/i.test(String(r || '')), `frase "${f}" não acha Mercado Pago no texto`, `veio ${r}`);
  }

  console.log('\n── 2. "mercado pago" POR EXTENSO é a conta ──');
  for (const t of ['mercado pago', 'conta mercado pago', 'mercado pago.', 'no mercado pago']) {
    const r = await inj(t);
    eq(r, 'Mercado Pago', `"${t}" resolve pra Mercado Pago`);
  }
  eq(await injTexto('gastei 20 no uber com mercado pago'), 'Mercado Pago',
     'acha "mercado pago" solto na frase');

  console.log('\n── 3. de mão dupla: a CONTA não vira a CATEGORIA ──');
  // "mercado pago" no fim da frase é a conta; a categoria tem de vir do ITEM.
  for (const [f, catProibida] of [
    ['gastei 3 reais no ifood com mercado pago', 'Mercado'],
    ['paguei 50 da netflix no mercado pago',     'Mercado'],
    ['gastei 20 no uber usando mercado pago',    'Mercado'],
  ]) {
    const d = interpretarRapido(f) || {};
    ok(d.categoria !== catProibida, `"${f}" não cai na categoria ${catProibida}`, `veio ${d.categoria}`);
  }
  // O caso genuinamente ambíguo: compra NO mercado paga COM mercado pago.
  // As duas leituras coexistem, e é o único jeito certo.
  {
    const d = interpretarRapido('gastei 80 no mercado com mercado pago') || {};
    eq(d.categoria, 'Mercado', 'compra no mercado paga com Mercado Pago: categoria Mercado');
    eq(await inj(d.carteira_nome), 'Mercado Pago', '...e a conta Mercado Pago');
  }

  console.log('\n── 4. a folga do fuzzy que separa os dois ──');
  // Se algum dia alguém baixar o limiar de 0.8, este caso cai primeiro.
  eq(await inj('mercado'), null,
     '"mercado" fica SEM conta (a similaridade com "Mercado Pago" é 0.58)');

  console.log(falhas ? `\n✗ ${falhas} falha(s)` : '\n✓ mercado x mercado pago: todos os casos passaram');
  process.exit(falhas ? 1 : 0);
})();
