// =============================================================================
// EVAL de `aplicarAporte` (services/aporteInvestimento).
//
// O erro caro aqui é INVISÍVEL: aporte que não mexe na quantidade não dá
// mensagem de erro nenhuma — ele grava, a tela mostra o valor subindo, e só na
// próxima atualização de preço o número volta pro tamanho da posição antiga.
// O usuário vê prejuízo numa compra. Por isso a seção 2 é a mais densa.
//
// A seção 4 trava a REGRESSÃO ZERO: sem quantidade informada, o resultado tem
// de ser idêntico ao comportamento antigo (`valor_aportado += v`,
// `valor_atual += v`, mais nada). Metade da base é renda fixa e passa por aí.
//
// Rodar:  npm run eval:aporte
// =============================================================================
const { aplicarAporte, recusaSeDoBanco } = require('../src/services/aporteInvestimento');
const { aplicarResgate } = require('../src/services/resgateInvestimento');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const perto = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) <= tol;

// ── 1. Valor inválido é recusado ───────────────────────────────────────────
console.log('── 1. entrada inválida ──');
{
  const inv = { valor_aportado: 100, valor_atual: 100, quantidade: 5 };
  for (const v of [0, -10, null, undefined, 'abc', NaN]) {
    ok(aplicarAporte(inv, { valor: v }).ok === false, `valor ${JSON.stringify(v)} deveria ser recusado`);
  }
  // Quantidade informada tem de ser positiva — zero aqui é digitação errada,
  // não "renda fixa": quem não tem cota simplesmente não manda o campo.
  ok(aplicarAporte(inv, { valor: 10, quantidade: 0 }).ok === false, 'quantidade 0 deveria ser recusada');
  ok(aplicarAporte(inv, { valor: 10, quantidade: -2 }).ok === false, 'quantidade negativa deveria ser recusada');
  ok(aplicarAporte(inv, { valor: 10, quantidade: 'x' }).ok === false, 'quantidade não-numérica deveria ser recusada');
}
console.log('  ok');

// ── 2. O CASO DO RELATO: comprar mais cotas ────────────────────────────────
console.log('── 2. o caso do relato (RADL3, conta real) ──');
{
  // Estado medido na base ANTES do aporte: 5 cotas a R$ 19,53.
  const inv = { valor_aportado: 97.65, valor_atual: 98.30, quantidade: 5, preco_unitario: 19.53 };
  const r = aplicarAporte(inv, { valor: 19.63, quantidade: 1 });

  ok(r.ok, 'aporte com quantidade deveria passar');
  ok(r.patch.quantidade === 6, `quantidade deveria virar 6, veio ${r.patch.quantidade}`);
  ok(perto(r.patch.valor_aportado, 117.28), `aportado deveria ser 117,28, veio ${r.patch.valor_aportado}`);
  ok(perto(r.patch.valor_atual, 117.93), `atual deveria ser 117,93, veio ${r.patch.valor_atual}`);
  // PM = 117,28 ÷ 6 = 19,546666…
  ok(perto(r.patch.preco_unitario, 19.5467, 0.0001), `PM deveria ser ~19,5467, veio ${r.patch.preco_unitario}`);

  // ⚠️ A PROVA DE QUE O BUG MORREU: o refresh de preço recalcula
  // `cotação × quantidade`. Com a quantidade certa, ele não apaga mais o aporte.
  const cotacao = 19.66;
  const depoisDoRefresh = cotacao * r.patch.quantidade;
  ok(perto(depoisDoRefresh, 117.96), `refresh deveria dar ~117,96, deu ${depoisDoRefresh}`);
  ok(depoisDoRefresh > r.patch.valor_aportado - 1,
     'depois do refresh o valor atual não pode desabar abaixo do aportado (era o prejuízo falso)');

  // E o que acontecia ANTES: quantidade parada em 5.
  const bugAntigo = cotacao * 5;
  ok(perto(bugAntigo, 98.30), 'sanidade do cenário antigo');
  ok(bugAntigo < 117.28, 'o cenário antigo realmente mostrava prejuízo — é o que a correção elimina');
}
console.log('  ok');

// ── 3. Primeira compra de um ativo que ainda não tinha quantidade ──────────
console.log('── 3. quantidade nascendo do zero ──');
{
  const inv = { valor_aportado: 0, valor_atual: 0, quantidade: null };
  const r = aplicarAporte(inv, { valor: 500, quantidade: 10 });
  ok(r.ok, 'deveria passar');
  ok(r.patch.quantidade === 10, `quantidade deveria ser 10, veio ${r.patch.quantidade}`);
  ok(perto(r.patch.preco_unitario, 50), `PM deveria ser 50, veio ${r.patch.preco_unitario}`);
}
console.log('  ok');

// ── 4. REGRESSÃO ZERO: sem quantidade, nada muda além do dinheiro ──────────
console.log('── 4. renda fixa (sem quantidade) continua igual ──');
{
  const casos = [
    { valor_aportado: 8228.51, valor_atual: 8228.51, quantidade: 1 },   // CDB da base
    { valor_aportado: 0,       valor_atual: 0,       quantidade: null },
    { valor_aportado: 1571.81, valor_atual: 1571.81, quantidade: 1 },   // Tesouro
  ];
  for (const inv of casos) {
    const r = aplicarAporte(inv, { valor: 250 });
    ok(r.ok, 'aporte sem quantidade deveria passar');
    ok(!('quantidade' in r.patch), 'sem quantidade informada o patch NÃO pode tocar na quantidade');
    ok(!('preco_unitario' in r.patch), 'sem quantidade informada o patch NÃO pode tocar no preço unitário');
    ok(perto(r.patch.valor_aportado, (inv.valor_aportado || 0) + 250), 'aportado deveria somar o valor');
    ok(perto(r.patch.valor_atual, (inv.valor_atual || 0) + 250), 'atual deveria somar o valor');
  }
}
console.log('  ok');

// ── 5. Fração: cripto e cota de fundo ──────────────────────────────────────
console.log('── 5. quantidade fracionária não pode ser arredondada pra inteiro ──');
{
  const inv = { valor_aportado: 1000, valor_atual: 1000, quantidade: 0.00381 };
  const r = aplicarAporte(inv, { valor: 500, quantidade: 0.0019 });
  ok(perto(r.patch.quantidade, 0.00571, 1e-9), `quantidade deveria ser 0,00571, veio ${r.patch.quantidade}`);

  // ⚠️ Preço unitário NÃO passa por arredondamento de centavo: a base tem cota
  // valendo R$ 0,0101, que em 2 casas viraria 0,01 e erraria a posição em 1%.
  const barato = { valor_aportado: 2, valor_atual: 2.01, quantidade: 200 };
  const r2 = aplicarAporte(barato, { valor: 1, quantidade: 100 });
  ok(perto(r2.patch.preco_unitario, 0.01, 0.0001), `PM deveria ser 0,01, veio ${r2.patch.preco_unitario}`);
  const fino = { valor_aportado: 1.01, valor_atual: 1.01, quantidade: 100 };
  const r3 = aplicarAporte(fino, { valor: 0.01, quantidade: 1 });
  ok(r3.patch.preco_unitario !== 0.01 || perto(r3.patch.preco_unitario, 0.010099, 0.0001),
     `PM fino deveria manter as casas, veio ${r3.patch.preco_unitario}`);
}
console.log('  ok');

// ── 6. SIMETRIA com o resgate — aportar e resgatar volta ao começo ─────────
console.log('── 6. aporte e resgate são inversos ──');
{
  // Era esta simetria que faltava: o resgate SEMPRE mexeu na quantidade, e o
  // aporte não mexia em nenhuma. Comprar 5 cotas e vender tudo tem de voltar
  // ao estado inicial.
  const inicio = { valor_aportado: 1000, valor_atual: 1000, quantidade: 10 };
  const ap = aplicarAporte(inicio, { valor: 500, quantidade: 5 });
  const meio = { ...inicio, ...ap.patch };
  ok(meio.quantidade === 15, `depois do aporte deveria ter 15 cotas, tem ${meio.quantidade}`);

  // Resgata exatamente a parte que entrou (500 de 1500 = 1/3).
  const rg = aplicarResgate(meio, 500);
  ok(rg.ok, 'resgate deveria passar');
  const fim = { ...meio, ...rg.patch };
  ok(perto(fim.quantidade, 10, 1e-6), `deveria voltar a 10 cotas, veio ${fim.quantidade}`);
  ok(perto(fim.valor_aportado, 1000), `aportado deveria voltar a 1000, veio ${fim.valor_aportado}`);
  ok(perto(fim.valor_atual, 1000), `atual deveria voltar a 1000, veio ${fim.valor_atual}`);
}
console.log('  ok');

// ── 7. Trava do Open Finance ───────────────────────────────────────────────
console.log('── 7. posição do banco não aceita lançamento manual ──');
{
  // O sync reescreve quantidade/preço/valores a cada rodada: aceitar aqui
  // seria gravar um número que some sozinho amanhã.
  ok(!!recusaSeDoBanco({ of_id: 'abc-123' }, 'aporte'), 'investimento com of_id deveria ser recusado');
  ok(!!recusaSeDoBanco({ origem: 'of' }, 'resgate'), 'investimento com origem=of deveria ser recusado');
  ok(recusaSeDoBanco({ of_id: 'x' }, 'aporte').motivo === 'investimento_do_open_finance',
     'o motivo precisa ser legível pela tela, não só a frase');

  // ⚠️ E o manual NÃO pode ser barrado por tabela: é a maioria do que o
  // cliente do relato tem (34 investimentos, quase todos cadastrados à mão).
  ok(recusaSeDoBanco({}, 'aporte') === null, 'investimento manual deveria passar');
  ok(recusaSeDoBanco({ of_id: null, origem: 'manual' }, 'aporte') === null,
     'origem manual explícita deveria passar');
  ok(recusaSeDoBanco(null, 'aporte') === null, 'sem investimento (aporte avulso) deveria passar');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.log(`❌ ${falhas.length} falha(s):`);
  for (const f of falhas) console.log('   · ' + f);
  process.exit(1);
}
console.log('✅ aplicarAporte: tudo passou');
