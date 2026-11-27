// =============================================================================
// EVAL — fatura aberta CONFERIDA PELO LIMITE (services/marcaDoBanco.js) e a
// ligação no sync (polpCelcoinSync). Rodar: node evals/faturaConferida.eval.js
// =============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
const fs = require('fs');
const path = require('path');
const B = require('../src/services/marcaDoBanco');
const { money } = require('../src/services/polpCelcoinSync');

const falhas = [];
let total = 0;
const eq = (a, b, m) => { total++; if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push(`${m}\n      esperado ${JSON.stringify(b)}\n      veio     ${JSON.stringify(a)}`); };

const g = (v, fc, obs = 'compra', x = {}) => ({ tipo: 'Gasto', valor: v, categoria: 'Outros', observacao: obs, of_bill_id: null, of_bill_forecast: fc, ...x });
const r = (v, fc, obs, cat, x = {}) => ({ tipo: 'Recebimento', valor: v, categoria: cat, observacao: obs, of_bill_id: null, of_bill_forecast: fc, ...x });
const lim = (usado) => ({ credit_line_limit_type: 'LIMITE_CREDITO_TOTAL', used_amount: { amount: String(usado), currency: 'BRL' } });

// ── §1 Nubank do relato: a linha que soma tudo (917,42) confere ────────────
const NU = [
  g(617.78, '2026-12', 'compras do ciclo'), r(30.98, '2026-12', 'Estorno de iFood - NuPay', 'Reembolso'),
  g(224.35, '2027-01'), g(66.37, '2027-02'), g(19.95, '2027-03'), g(19.95, '2027-04'),
  g(49.2, '2026-11', 'já faturada', { of_bill_id: 'a00de1' }),
];
const usadosNu = B.usadosDoLimite([lim(917.42), lim(86.44), lim(830.98), lim(830.98), lim(0)], money);
eq(usadosNu, [917.42, 86.44, 830.98], '§1 os usados distintos e positivos de todas as linhas de limite');
eq(B.faturaConferidaPeloLimite({ linhas: NU, competencia: '2026-12', usados: usadosNu }),
  { valor: 586.8, futuras: 330.62, usado: 917.42 }, '§1 Nubank: 586,80 (o app do banco), conferido por 586,80 + 330,62 = 917,42');

// ── §2 Mercado Pago do relato: unbilled 0, o usado inclui jan/fev ──────────
const MP = [
  g(1531.01, '2026-12', 'compras do ciclo'),
  r(1194.87, '2026-12', 'Pagamento da fatura', 'Outros'),   // paga a de novembro: fica FORA
  g(257.54, '2027-01'), g(206.87, '2027-02'),
];
eq(B.faturaConferidaPeloLimite({ linhas: MP, competencia: '2026-12', usados: [1995.42] }),
  { valor: 1531.01, futuras: 464.41, usado: 1995.42 }, '§2 Mercado Pago: 1.531,01, conferido por 1.531,01 + 464,41 = 1.995,42');

// ── §3 Quando NÃO pode agir ────────────────────────────────────────────────
eq(B.faturaConferidaPeloLimite({ linhas: [g(695.12, '2026-12')], competencia: '2026-12', usados: [3214] }), null,
  '§3 PicPay do relato: o limite (3.214) não confere com nada → fica como está');
eq(B.faturaConferidaPeloLimite({ linhas: NU, competencia: '2026-12', usados: [917.43] }), null,
  '§3 um centavo de diferença já não é conferência');
eq(B.faturaConferidaPeloLimite({ linhas: [g(335.58, '2026-12')], competencia: '2026-12', usados: [336.32] }), null,
  '§3 R$ 0,74 de diferença (caso real do Itaú) não confere');
eq(B.faturaConferidaPeloLimite({ linhas: [g(100, '2026-12'), r(300, '2026-12', 'Estorno', 'Reembolso'), g(400, '2027-01')], competencia: '2026-12', usados: [200] }), null,
  '§3 fatura aberta NEGATIVA (crédito do cliente) fica com a regra de sempre');
eq(B.faturaConferidaPeloLimite({ linhas: [], competencia: '2026-12', usados: [0, 50] }), null, '§3 sem linha nenhuma não confere');
eq(B.faturaConferidaPeloLimite({ linhas: NU, competencia: '2026-12', usados: [] }), null, '§3 sem limite do banco não confere');
eq(B.faturaConferidaPeloLimite({ linhas: NU, competencia: 'dez', usados: usadosNu }), null, '§3 competência inválida');
eq(B.faturaConferidaPeloLimite({ linhas: [g(80, '2026-12'), g(20, '2027-01')], competencia: '2026-12', usados: [100] }),
  { valor: 80, futuras: 20, usado: 100 }, '§3 confere ao centavo exato');

// ── §4 As partes ──────────────────────────────────────────────────────────
eq(B.futurasPelaMarca([g(10, '2027-01'), r(3, '2027-01', 'Estorno X', 'Reembolso'), r(50, '2027-01', 'Pagamento recebido', 'Fatura'), g(5, '2026-12'), g(7, '2026-11'), g(9, null), g(4, '2027-02', 'x', { of_bill_id: 'b' })], '2026-12'), 7,
  '§4 futuras: depois da competência, crédito abate, pagamento e já faturada ficam fora, sem marca não conta');
eq(B.somaPelaMarcaDoBanco([g(10, '2026-12', 'x', { valor_moeda: 2 })], '2026-12').valor, 2, '§4 na moeda do CARTÃO');
eq(B.ehPagamentoDeFatura(r(5, '2026-12', 'PAGAMENTO CASHBACK TAG', 'Reembolso')), false, '§4 cashback NÃO é pagamento (abate)');
eq(B.ehPagamentoDeFatura(r(5, '2026-12', 'PAGTO.BOLETO', 'Reembolso')), true, '§4 "PAGTO.BOLETO" da Caixa é pagamento');
eq(B.ehPagamentoDeFatura(g(5, '2026-12', 'Pagamento da fatura')), false, '§4 débito nunca é pagamento');

// ── §5 A ligação no sync ───────────────────────────────────────────────────
const fonte = fs.readFileSync(path.join(__dirname, '../src/services/polpCelcoinSync.js'), 'utf8').replace(/\r\n/g, '\n');
const i = fonte.indexOf('FATURA ABERTA CONFERIDA PELO LIMITE');
const bloco = fonte.slice(i, i + 2200);
eq(i > 0 && fonte.indexOf('parcelasProjetadas = await gravarParcelasPrevistas(') < i, true, '§5 roda depois das parcelas previstas (transações já gravadas)');
eq(/process\.env\.OF_FATURA_CONFERIDA !== '0'/.test(bloco), true, '§5 tem interruptor (OF_FATURA_CONFERIDA=0)');
// ⚠️ Caso real (27/11/2026, primeira versão): calculada pela competência "atual",
// um Itaú entre o fechamento e o vencimento recebeu o valor da fatura FECHADA
// (222,54) no lugar do da aberta. A tela mostra o saldo na fatura SEGUINTE à
// última publicada — a regra tem de usar a MESMA.
eq(/const comp = competenciaDoSimulado\(w, await faturasDoCartao\(w\.id\)\) \|\| competenciaAtual\(w, hoje\);/.test(bloco), true,
  '§5 usa a MESMA competência em que a tela mostra o saldo (a do simulado)');
const vista = fs.readFileSync(path.join(__dirname, '../src/services/faturaVista.js'), 'utf8');
eq(/competencia === \(competenciaDoSimulado\(cartao, faturas\) \|\| competenciaAtual\(cartao\)\)/.test(vista), true,
  '§5 …e é essa a competência que o faturaVista usa pro saldo (se mudar lá, mudar aqui)');
eq(/\.eq\('grupo_id', grupoId\)\.eq\('carteira_nome', w\.nome\)\s*\.is\('of_bill_id', null\)\.gte\('of_bill_forecast', comp\)/.test(bloco), true,
  '§5 lê do BANCO DE DADOS as linhas do PRÓPRIO cartão, sem fatura, da competência atual em diante');
eq(/usadosDoLimite\(raw\.limits, money\)/.test(bloco), true, '§5 confere contra os limites crus do cartão');
eq(/const conf = eAb \? null :/.test(bloco), true, '§5 leitura que falha não confere nada');
eq(/\.from\('wallets'\)\.update\(\{ saldo: -conf\.valor \}\)\.eq\('id', w\.id\)/.test(bloco), true, '§5 só grava o SALDO daquele cartão');
eq((bloco.match(/\.update\(/g) || []).length, 1, '§5 nenhuma outra escrita');

console.log(`${total} verificações · ${falhas.length ? `${falhas.length} FALHAS` : 'todas ok'}`);
if (falhas.length) { for (const f of falhas) console.log('  ✘ ' + f); process.exit(1); }
