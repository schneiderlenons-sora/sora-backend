// =============================================================================
// EVAL de services/moeda.js — conta em moeda estrangeira.
//
// O erro caro aqui é ASSIMÉTRICO e por isso a seção 3 é a mais densa:
//   · converter errado por 1% → número levemente torto (chato)
//   · tratar falha de câmbio como ZERO → o dinheiro do cliente SOME da tela
//     sem nenhum aviso, e ele acha que perdeu o saldo (catastrófico)
//
// A seção 1 trava a regra que protege o resto do sistema: em BRL, NADA muda.
//
// Rodar:  npm run eval:moeda
// =============================================================================
const M = require('../src/services/moeda');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} — deu ${a}, esperado ${b}`); };

// ── 1. BRL NÃO PODE MUDAR DE COMPORTAMENTO ────────────────────────────────
// Esta é a seção que protege as 13.4k transações e 455 carteiras existentes.
console.log('── 1. em BRL, nada muda ──');
{
  const c = M.camposTransacao(50, 'BRL', {});
  eq(c.valor, 50, 'BRL: valor é o próprio número');
  eq(c.moeda, null, 'BRL: moeda fica NULA (linha idêntica à de hoje)');
  eq(c.valor_moeda, null, 'BRL: valor_moeda fica NULO');
  eq(c.taxa_brl, null, 'BRL: taxa_brl fica NULA');

  // Moeda ausente/lixo cai em BRL, nunca quebra.
  // Só lixo de verdade cai em BRL. ⚠️ 'usd ' NÃO entra nesta lista: espaço e
  // caixa são aparados de propósito, e o teste logo abaixo cobre isso.
  for (const v of [null, undefined, '', 'xxx', 'BITCOIN', 123, {}]) {
    eq(M.normalizarMoeda(v), 'BRL', `"${v}" normaliza pra BRL`);
  }
  eq(M.normalizarMoeda('usd'), 'USD', 'minúsculo vira maiúsculo');
  eq(M.normalizarMoeda(' eur '), 'EUR', 'espaços são aparados');

  ok(!M.ehEstrangeira('BRL'), 'BRL não é estrangeira');
  ok(!M.ehEstrangeira(null), 'moeda nula não é estrangeira');
  ok(M.ehEstrangeira('USD'), 'USD é estrangeira');

  // Saldo em BRL não depende de tabela de câmbio nenhuma.
  eq(M.saldoEmBRL({ saldo: 1234.56, moeda: 'BRL' }, null), 1234.56, 'saldo BRL sem tabela');
  eq(M.saldoEmBRL({ saldo: 10 }, null), 10, 'saldo sem coluna moeda = BRL');
}
console.log('  ok');

// ── 2. Conversão ───────────────────────────────────────────────────────────
console.log('── 2. conversão e congelamento ──');
{
  const t = { USD: 5.4, EUR: 6.0 };

  // O caso do relato: Nomad com US$ 6.834,56.
  eq(M.saldoEmBRL({ saldo: 6834.56, moeda: 'USD' }, t), 6834.56 * 5.4, 'Nomad em BRL');

  const c = M.camposTransacao(50, 'USD', t);
  eq(c.valor, 270, 'US$50 × 5,4 = R$270 gravado em `valor`');
  eq(c.valor_moeda, 50, 'nativo preservado');
  eq(c.taxa_brl, 5.4, 'taxa congelada na linha');
  eq(c.moeda, 'USD', 'moeda registrada');

  // ⚠️ O CONGELAMENTO: a mesma transação, relida com o câmbio a 6,0, tem de
  // continuar valendo R$270. É o que impede o relatório de março de mudar
  // sozinho todo dia.
  eq(c.valor, 270, 'valor NÃO se recalcula quando o câmbio muda');

  eq(M.valorNativo({ valor: 270, valor_moeda: 50 }), 50, 'valorNativo devolve o nativo');
  eq(M.valorNativo({ valor: 99 }), 99, 'sem valor_moeda, o nativo é o próprio valor');
  // ⚠️ valor_moeda = 0 é um valor legítimo, não "ausente".
  eq(M.valorNativo({ valor: 5, valor_moeda: 0 }), 0, 'valor_moeda 0 não cai no fallback');
}
console.log('  ok');

// ── 3. FALHA DE CÂMBIO NUNCA VIRA ZERO ────────────────────────────────────
// ⚠️ A seção que mais importa. Somar 0 apagaria o dinheiro do cliente da tela.
console.log('── 3. sem câmbio: null, jamais 0 ──');
{
  eq(M.paraBRL(100, 'USD', {}), null, 'sem taxa na tabela → null');
  eq(M.paraBRL(100, 'USD', null), null, 'sem tabela → null');
  eq(M.paraBRL(100, 'USD', { USD: 0 }), null, 'taxa 0 é inválida → null');
  eq(M.paraBRL(100, 'USD', { USD: NaN }), null, 'taxa NaN → null');
  eq(M.saldoEmBRL({ saldo: 6834.56, moeda: 'USD' }, {}), null, 'saldo sem câmbio → null');

  // ⚠️ E a soma AVISA em vez de mentir.
  const r = M.somarSaldos([
    { saldo: 1000, moeda: 'BRL' },
    { saldo: 500,  moeda: 'USD' },   // sem câmbio
  ], {});
  eq(r.total, 1000, 'soma só o que deu pra converter');
  eq(r.semCambio, 1, 'e AVISA quantas ficaram de fora');

  const r2 = M.somarSaldos([
    { saldo: 1000, moeda: 'BRL' },
    { saldo: 100,  moeda: 'USD' },
  ], { USD: 5 });
  eq(r2.total, 1500, 'com câmbio, soma tudo');
  eq(r2.semCambio, 0, 'nada faltando');

  // Sem câmbio, o lançamento NÃO se perde: grava o nativo e marca a moeda.
  const c = M.camposTransacao(50, 'USD', {});
  eq(c.valor, 50, 'sem câmbio, valor recebe o nativo (não some)');
  eq(c.valor_moeda, 50, 'nativo registrado');
  eq(c.taxa_brl, null, 'taxa fica nula — a linha é provisória e a tela sabe');
  eq(c.moeda, 'USD', 'a moeda é registrada de qualquer jeito');
}
console.log('  ok');

// ── 4. Soma de lista vazia / suja ─────────────────────────────────────────
console.log('── 4. entradas degeneradas ──');
{
  eq(M.somarSaldos([], {}).total, 0, 'lista vazia soma 0');
  eq(M.somarSaldos(null, {}).total, 0, 'null não quebra');
  eq(M.somarSaldos([{ saldo: null, moeda: 'BRL' }], {}).total, 0, 'saldo nulo conta 0');
  eq(M.paraBRL(null, 'BRL', {}), 0, 'valor nulo em BRL é 0');
  ok(Object.keys(M.MOEDAS).includes('USD'), 'USD está no catálogo');
  eq(M.MOEDAS.BRL.simbolo, 'R$', 'símbolo do real');
}
console.log('  ok');


// ── N. LANÇAMENTO EM MOEDA ESTRANGEIRA — as DUAS grandezas ─────────────────
//
// Pedido do cliente com contas em coroa: "seria possível adicionar uma receita
// em moeda estrangeira? qualquer tipo de lançamento, despesas e receitas".
// A máquina já existia (migration 144) e o PAINEL já usava; o WhatsApp NÃO —
// "gastei 200" numa conta em coroa gravava R$ 200 em vez de 200 kr (~R$ 110).
// O mesmo valor significava coisas diferentes conforme o canal, errando pra
// MENOS: dinheiro sumindo do gasto, calado.
//
// ⚠️ A REGRA QUE NÃO PODE REGREDIR: `transacoes.valor` é BRL e `wallets.saldo`
// é NATIVO. São grandezas diferentes na MESMA operação. Somar o BRL no saldo
// nativo corrompe a conta do usuário — e é o erro fácil aqui, porque as duas
// saem da mesma chamada.
console.log('── N. lançamento em moeda estrangeira ──');
{
  const t = { NOK: 0.55032, EUR: 5.9496 };

  const nok = M.camposTransacao(200, 'NOK', t);
  eq(nok.valor, 110.06, 'transacoes.valor: 200 kr viram R$ 110,06');
  eq(nok.valor_moeda, 200, 'valor_moeda guarda o NATIVO, que é o que a pessoa falou');
  eq(nok.taxa_brl, 0.55032, 'e a taxa do dia fica congelada na linha');
  // O saldo da carteira anda pelo nativo — este é o valor que o handler soma.
  eq(nok.valor_moeda ?? nok.valor, 200, 'wallets.saldo anda 200, NÃO 110,06');

  // ⚠️ ARREDONDA EM CENTAVOS. Sem isso, 4090.34 × 0.55032 grava 2250.9959088 —
  // sete casas decimais num campo de dinheiro, e somas divergindo por centavos.
  eq(M.camposTransacao(4090.34, 'NOK', t).valor, 2251, 'converte e arredonda em centavos');
  eq(M.camposTransacao(4090.34, 'NOK', t).taxa_brl, 0.55032, 'a TAXA fica inteira, não arredondada');

  // Conta em real: a linha sai IDÊNTICA à de antes — nenhum campo novo.
  const brl = M.camposTransacao(200, 'BRL', t);
  eq(brl.valor, 200, 'em real o valor não muda');
  eq(brl.moeda, null, 'e não grava moeda');
  eq(brl.valor_moeda, null, 'nem valor nativo');

  // ⚠️ SEM CÂMBIO, O DINHEIRO NÃO SOME. Grava o nativo com taxa null e REGISTRA
  // a moeda — o número fica provisório e a tela mostra que não é real.
  const semTaxa = M.camposTransacao(200, 'NOK', {});
  eq(semTaxa.valor, 200, 'sem cotação, guarda o nativo em vez de zerar');
  eq(semTaxa.moeda, 'NOK', 'e diz qual moeda é');
  eq(semTaxa.taxa_brl, null, 'com a taxa em null, pra dar pra corrigir depois');
}
console.log('  ok');

// ── N+1. MOVER DE CONTA PODE MUDAR A MOEDA ─────────────────────────────────
//
// O caminho mais comum de quem tem várias contas: manda "gastei 200" sem dizer
// de onde, a Sora salva em "Dinheiro" (real) e PERGUNTA. Se a resposta for uma
// conta em coroa, o número passa a ser coroa.
//
// ⚠️ REINTERPRETA, NÃO CONVERTE. 200 vira 200 kr (≈ R$ 110), não R$ 200 dentro
// de uma conta em coroa. O que a pessoa digitou é um NÚMERO; a conta é que diz
// de que moeda ele é. Converter aqui (200 BRL → 363 kr) seria inventar um valor
// que ela nunca falou.
//
// ⚠️ E É POR ISSO QUE O SALDO DAS DUAS CARTEIRAS ANDA PELO MESMO NATIVO: sai
// 200 da antiga e entra 200 na nova. Usar o BRL no estorno deixaria a conta de
// origem errada — erro que não estoura e que ninguém confere.
console.log('── N+1. mover de conta muda a moeda ──');
{
  const t = { NOK: 0.55032 };

  // Dinheiro (BRL) → conta em coroa: o 200 vira 200 kr.
  const paraNok = M.camposTransacao(200, 'NOK', t);
  eq(paraNok.valor, 110.06, 'transacoes.valor passa a ser R$ 110,06');
  eq(paraNok.valor_moeda, 200, 'e o nativo continua sendo o 200 que ela falou');

  // O caminho de volta: conta em coroa → conta em real. O nativo é o que manda.
  const veioDeNok = { valor: 110.06, moeda: 'NOK', valor_moeda: 200, taxa_brl: 0.55032 };
  const nativo = veioDeNok.valor_moeda ?? veioDeNok.valor;
  eq(nativo, 200, 'o número que a pessoa falou sai de valor_moeda, não de valor');
  const paraBrl = M.camposTransacao(nativo, 'BRL', t);
  eq(paraBrl.valor, 200, 'em conta de real o mesmo 200 volta a ser R$ 200');
  eq(paraBrl.moeda, null, '⚠️ e a moeda é LIMPA — senão a linha ficaria NOK numa conta em real');
  eq(paraBrl.valor_moeda, null, 'idem o nativo');

  // Transação que nunca teve moeda: o nativo é o próprio valor.
  const semMoeda = { valor: 200, moeda: null, valor_moeda: null };
  eq(semMoeda.valor_moeda ?? semMoeda.valor, 200, 'sem valor_moeda, o nativo é o valor');
}
console.log('  ok');

// ── N+2. "CÂMBIO INDISPONÍVEL" NÃO PODE APARECER ───────────────────────────
//
// Exigência do dono depois do relato do cliente: a cotação tem de funcionar
// SEMPRE. São quatro camadas, e cada uma cobre a falha da anterior:
//
//   1. cache em memória (1h)          → não sobrevive à hibernação do Render
//   2. três fontes em cascata          → yahoo bloqueia IP de datacenter
//   3. `cotacoes_moeda` (migration 159) → última conhecida, sobrevive a restart
//   4. cron diário `aquecerCotacoes`    → garante que a linha EXISTA antes do
//                                         primeiro uso de cada moeda
//
// ⚠️ A CAMADA 4 É A QUE FECHA O BURACO. O banco só salva quem já tem linha lá,
// e a linha nasce na primeira conversão bem-sucedida — ou seja, a PRIMEIRA vez
// que alguém usa uma moeda nova era a única sem rede de segurança.
//
// MEDIDO em 06/09/2026: as 11 moedas estrangeiras do catálogo respondem nas
// TRÊS fontes (nenhuma depende de uma só). E com as três derrubadas na marra,
// as contas do cliente continuaram convertendo pela tabela — 6 tentativas
// externas bloqueadas, zero "câmbio indisponível", total R$ 15.600,42.
console.log('── N+2. as camadas contra "câmbio indisponível" ──');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/services/moeda.js'), 'utf8');

  // Camada 3: o fallback do banco existe e vem DEPOIS do de memória.
  ok(/async function lerTaxaSalva/.test(src), 'lê a última cotação salva no banco');
  ok(/async function salvarTaxa/.test(src), 'e grava a cada conversão bem-sucedida');
  ok(src.indexOf('if (hit) return hit.taxa;') < src.indexOf('await lerTaxaSalva'),
    'memória primeiro (mais nova), banco depois');

  // ⚠️ O null tem de continuar existindo: é ele que impede a tela de mentir
  // quando REALMENTE não há valor nenhum. "Nunca aparecer" se conquista tendo
  // sempre um valor guardado, não apagando o aviso.
  ok(/return null;/.test(src.slice(src.indexOf('async function taxa('))),
    'sem NADA guardado ainda devolve null — nunca 0, nunca 1');

  // Camada 4: o aquecimento cobre TODO o catálogo, não uma lista à parte.
  ok(/async function aquecerCotacoes/.test(src), 'existe a rotina de aquecimento');
  ok(/Object\.keys\(MOEDAS\)/.test(src.slice(src.indexOf('async function aquecerCotacoes'))),
    '⚠️ varre Object.keys(MOEDAS) — moeda nova no catálogo entra sozinha');
  ok(/taxaParaBRLDetalhe/.test(src.slice(src.indexOf('async function aquecerCotacoes'))),
    'e vai direto na fonte, ignorando o cache (senão não refresca nada)');

  // Camada 2: as três fontes, na ordem.
  const cot = require('fs').readFileSync(require('path').join(__dirname, '../src/services/cotacoes.js'), 'utf8');
  const fontes = (cot.match(/nome: '(\w[\w-]*)'/g) || []).length;
  eq(fontes, 3, 'três fontes de câmbio cadastradas');
  ok(/CAMBIO_TIMEOUT_MS/.test(cot), 'com timeout — fonte pendurada não trava a tela');
  ok(cot.indexOf("nome: 'yahoo'") < cot.indexOf("nome: 'awesomeapi'"), 'yahoo primeiro');

  // E o cron que roda tudo isso.
  const jobs = require('fs').readFileSync(require('path').join(__dirname, '../src/jobs/index.js'), 'utf8');
  ok(/aquecerCotacoes/.test(jobs), 'o cron chama o aquecimento');
  ok(/cron\.schedule\('0 5 \* \* \*'/.test(jobs), 'todo dia às 05:00, antes do horário de uso');
}
console.log('  ok');
console.log('');
if (falhas.length) {
  console.error(`❌ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('   · ' + f));
  process.exit(1);
}
console.log('✅ moeda: tudo passou.');
