// =============================================================================
// EVAL — medição da fatura em aberto (services/medicaoFaturaAberta.js, 207).
// Rodar:  node evals/medicaoFaturaAberta.eval.js
// =============================================================================
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
const fs = require('fs');
const path = require('path');
const M = require('../src/services/medicaoFaturaAberta');

const falhas = [];
let total = 0;
const eq = (a, b, m) => { total++; if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push(`${m}\n      esperado ${JSON.stringify(b)}\n      veio     ${JSON.stringify(a)}`); };

// ── §1 A marcação do banco no caso real (Nubank do relato, 27/11/2026) ──────
// Linhas sem bill_id marcadas pra 2026-12; o app do banco mostrava 586,80.
const g = (v, obs, x = {}) => ({ tipo: 'Gasto', valor: v, categoria: 'iFood', observacao: obs, of_bill_id: null, of_bill_forecast: '2026-12', ...x });
const r = (v, obs, cat, x = {}) => ({ tipo: 'Recebimento', valor: v, categoria: cat, observacao: obs, of_bill_id: null, of_bill_forecast: '2026-12', ...x });
const NUBANK = [
  g(0, 'Juros de dívida encerrada'), r(0, 'Encerramento de dívida', 'Reembolso'),
  g(47, 'Hubla *Mundoleilao'), g(19.98, 'Mp *Anycar 1/3'), g(24.62, 'Mp *Historicocarservi 1/2'), g(24.62, 'Mp *Historicocarservi 1/2'),
  g(33.94, 'iFood'), g(22.49, 'iFood'), g(43.47, 'iFood Delivery'), r(30.98, 'Estorno de iFood - NuPay', 'Reembolso'),
  g(22.47, 'iFood'), g(30.27, 'iFood'), g(97, 'App*Finest'), g(37.34, 'iFood'), g(44.01, 'iFood'), g(19.99, 'Ec*Sora 1/5'),
  g(44.01, 'iFood'), g(56.21, 'iFood'), g(50.36, 'iFood'),
  // Já faturadas (bill_id) e de outras competências: ficam fora.
  r(0.96, 'Desconto de antecipação de pagamento', 'Reembolso', { of_bill_id: 'a00de1' }),
  g(49.2, 'iFood 2/2', { of_bill_id: 'a00de1', of_bill_forecast: '2026-11' }),
  g(33.53, 'iFood', { of_bill_forecast: '2027-01' }), g(26.46, 'iFood 1/2', { of_bill_forecast: '2027-01' }),
];
eq(M.somaPelaMarcaDoBanco(NUBANK, '2026-12').valor, 586.8, '§1 Nubank do relato: 586,80, o número do app do banco');
eq(M.somaPelaMarcaDoBanco(NUBANK, '2027-01').valor, 59.99, '§1 a competência seguinte só pega o que é dela');

// ── §2 Pagamento fica FORA; estorno e cashback ABATEM ──────────────────────
const MP = [
  g(1000, 'VELOE'),
  r(1194.87, 'Pagamento da fatura', 'Outros'),                    // MP do relato: pagamento gravado como "Outros"
  r(500, 'Pagamento de fatura', 'Fatura'),
  r(300, 'PAGTO.BOLETO', 'Reembolso'),                            // Caixa
  r(200, 'Pagamento recebido', 'Reembolso'),                      // Nubank
  r(10, 'Obrigado pelo pagamento', 'Outros'),
  r(5, 'PAGAMENTO CASHBACK TAG', 'Reembolso'),                    // cashback NÃO é pagamento
  r(97.27, 'SHOPEE *BerFantasias', 'Reembolso'),                  // estorno
];
eq(M.somaPelaMarcaDoBanco(MP, '2026-12').valor, 897.73, '§2 compra 1000 − cashback 5 − estorno 97,27; os 5 pagamentos ficam fora');
eq(M.somaPelaMarcaDoBanco(MP, '2026-12').linhas, 3, '§2 contam só a compra, o cashback e o estorno');
eq(M.ehPagamentoDeFatura({ tipo: 'Gasto', observacao: 'Pagamento da fatura' }), false, '§2 débito nunca é pagamento');
eq(M.somaPelaMarcaDoBanco([g(100, 'X', { valor_moeda: 20 })], '2026-12').valor, 20, '§2 na moeda do CARTÃO (valor_moeda)');
eq(M.somaPelaMarcaDoBanco([g(100, 'X', { of_bill_forecast: '2026-12-15' })], '2026-12').valor, 100, '§2 marca com dia completo vale pelo mês');
eq(M.somaPelaMarcaDoBanco([g(100, 'X', { of_bill_forecast: null })], '2026-12').valor, 0, '§2 sem marca não entra');
eq(M.somaPelaMarcaDoBanco(null, '2026-12'), { valor: 0, linhas: 0 }, '§2 lista vazia');

// ── §3 Comparação com a fatura publicada ───────────────────────────────────
const ret = (cartao_id, dia, sora, marca, x = {}) => ({ cartao_id, instituicao: 'Nubank', competencia: '2026-12', dia, sora_fatura: sora, marca_banco: marca, ...x });
const RET = [
  ret('nu', '2026-12-04', 480, 570),
  ret('nu', '2026-12-06', 500.36, 586.8),                         // ← o último até o fechamento (06/12)
  ret('nu', '2026-12-07', 900, 900),                              // depois do fechamento: ignorado
  ret('mp', '2026-12-05', 1995.42, 1531.01, { instituicao: 'Mercado Pago' }),
  ret('pic', '2026-12-04', 1120.71, 695.12, { instituicao: 'PicPay' }),
  ret('so', '2026-12-08', 10, 10, { instituicao: 'Itaú' }),         // tirado DEPOIS do fechamento → sem retrato
];
const PUB = [
  { cartao_id: 'nu', competencia: '2026-12', total: 586.8, fechamento: '2026-12-06' },
  { cartao_id: 'mp', competencia: '2026-12', total: 1531.01, fechamento: '2026-12-05' },
  { cartao_id: 'pic', competencia: '2026-12', total: 695.12, fechamento: '2026-12-04' },
  { cartao_id: 'so', competencia: '2026-12', total: 10, fechamento: '2026-12-07' },
  { cartao_id: 'x', competencia: '2026-12', total: null, fechamento: '2026-12-07' },  // sem total: fora
];
const c = M.compararRetratos(RET, PUB);
const nu = c.faturas.find((f) => f.cartao_id === 'nu');
eq(nu.retrato_de, '2026-12-06', '§3 usa o retrato mais recente ATÉ o fechamento (não o de depois)');
eq([nu.erroSora, nu.erroMarca], [86.44, 0], '§3 erro da tela × erro da marcação');
eq(c.semRetrato, 1, '§3 retrato só depois do fechamento não vale (o cartão fica sem retrato)');
eq(c.faturas.length, 3, '§3 fatura sem total fica de fora');
eq(c.porBanco.Nubank, { faturas: 1, soraExata: 0, marcaExata: 1, marcaMaisPerto: 1, soraMaisPerto: 0, empate: 0, erroSora: 86.44, erroMarca: 0 }, '§3 resumo por banco');
eq(c.porBanco['Mercado Pago'].marcaMaisPerto, 1, '§3 Mercado Pago: a marcação ganha');
const empate = M.compararRetratos([ret('a', '2026-12-01', 100, 100)], [{ cartao_id: 'a', competencia: '2026-12', total: 100.5, fechamento: '2026-12-02' }]);
eq([empate.porBanco.Nubank.empate, empate.porBanco.Nubank.soraExata, empate.porBanco.Nubank.marcaExata], [1, 1, 1], '§3 erro igual = empate; até R$ 1 conta como exata');
const ganhaSora = M.compararRetratos([ret('a', '2026-12-01', 100, 150)], [{ cartao_id: 'a', competencia: '2026-12', total: 100, fechamento: '2026-12-02' }]);
eq(ganhaSora.porBanco.Nubank.soraMaisPerto, 1, '§3 quando a tela acerta mais, conta pra tela');

// ── §4 O retrato (fotografar) com banco falso ──────────────────────────────
function bancoFalso({ semTabela = false, txs = {} } = {}) {
  const log = { upserts: [], filtrosTx: [] };
  const consulta = (tabela) => {
    const f = { tabela, eq: {}, ilike: {} };
    const q = {
      select() { return q; }, limit() { return q; }, range() { return q; }, in() { return q; },
      eq(k, v) { f.eq[k] = v; return q; }, ilike(k, v) { f.ilike[k] = v; return q; },
      upsert(rows, opts) { log.upserts.push({ tabela, rows, opts }); return Promise.resolve({ error: null }); },
      then(ok, ko) {
        let r;
        if (tabela === 'medicao_fatura_aberta') r = semTabela ? { data: null, error: { code: '42P01', message: 'relation "medicao_fatura_aberta" does not exist' } } : { data: [], error: null };
        else if (tabela === 'of_conexoes') r = { data: [{ external_id: 'c1', instituicao: 'Nubank' }, { external_id: 'c2', instituicao: 'PicPay' }], error: null };
        else if (tabela === 'wallets') r = { data: [
          { id: 'w1', grupo_id: 'g1', nome: 'Nubank Crédito', of_consent_id: 'c1', of_provider: 'polp-celcoin', of_conta_id: 'x1' },
          { id: 'w2', grupo_id: 'g2', nome: 'PicPay', of_consent_id: 'c2', of_provider: 'polp-celcoin', of_conta_id: 'x2' },
          { id: 'w3', grupo_id: 'g3', nome: 'Morto', of_consent_id: 'c9', of_provider: 'polp-celcoin', of_conta_id: 'x3' },  // conexão encerrada
        ], error: null };
        else if (tabela === 'transacoes') { log.filtrosTx.push(f); r = { data: txs[f.ilike.carteira_nome] || [], error: null }; }
        else r = { data: [], error: null };
        return Promise.resolve(r).then(ok, ko);
      },
    };
    return q;
  };
  return { log, from: consulta };
}
const faturasFalsas = async (grupoId) => {
  if (grupoId === 'g2') throw new Error('rede caiu');
  if (grupoId === 'g1') return [{ cartao_id: 'w1', competencia: '2026-12', fatura: 500.36, restante: 500.36 }];
  return [];
};

(async () => {
  const sem = bancoFalso({ semTabela: true });
  const r0 = await M.fotografar({ supabase: sem, hoje: '2026-11-27', faturasDoGrupo: faturasFalsas });
  eq(r0, { erro: 'sem_tabela' }, '§4 sem a 207: não faz nada');
  eq(sem.log.upserts.length, 0, '§4 sem a 207: nada gravado');

  const b = bancoFalso({ txs: { 'Nubank Crédito': NUBANK } });
  const r1 = await M.fotografar({ supabase: b, hoje: '2026-11-27', faturasDoGrupo: faturasFalsas });
  eq(r1, { cartoes: 2, gravados: 1, falhas: 1 }, '§4 cartão de conexão encerrada fica fora; grupo que falha não derruba os outros');
  const linha = b.log.upserts[0].rows[0];
  eq(linha, { cartao_id: 'w1', grupo_id: 'g1', instituicao: 'Nubank', competencia: '2026-12', dia: '2026-11-27',
    sora_fatura: 500.36, sora_restante: 500.36, marca_banco: 586.8, marca_linhas: 19 }, '§4 o retrato grava a tela e a marcação');
  eq(b.log.upserts[0].opts, { onConflict: 'cartao_id,competencia,dia' }, '§4 o 2º retrato do dia substitui o 1º');
  eq(b.log.filtrosTx[0].eq.of_bill_forecast, '2026-12', '§4 só lê as linhas marcadas pra competência (egress)');
  eq(b.log.upserts.every((u) => u.tabela === 'medicao_fatura_aberta'), true, '§4 só grava na tabela da medição');

  const rel = await M.relatorio({ supabase: bancoFalso({ semTabela: true }) });
  eq(rel, { erro: 'sem_tabela' }, '§4 relatório sem a 207 avisa');

  // ── §5 As ligações: rota protegida e job das 23h30 ───────────────────────
  const ler = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
  const rota = ler('src/routes/openFinance.js');
  const iRota = rota.indexOf("router.get('/diag-medicao'");
  eq(iRota > 0 && /API_SECRET_TOKEN \|\| req\.query\.key !== process\.env\.API_SECRET_TOKEN\) return res\.sendStatus\(403\)/.test(rota.slice(iRota, iRota + 300)), true, '§5 a rota exige a chave');
  const jobs = ler('src/jobs/index.js');
  const iJob = jobs.indexOf('JOB 1V');
  const corpo = jobs.slice(iJob, iJob + 2000);
  eq(/sp\.minutos < 23 \* 60 \+ 30\) return;/.test(corpo), true, '§5 o job só roda das 23h30 em diante (relógio de SP)');
  eq(/fotografar\(\{\s*supabase, hoje: sp\.dataStr, faturasDoGrupo:/.test(corpo), true, '§5 o job usa o dia de SP e o MESMO faturasDoGrupo da rota');

  console.log(`${total} verificações · ${falhas.length ? `${falhas.length} FALHAS` : 'todas ok'}`);
  if (falhas.length) { for (const f of falhas) console.log('  ✘ ' + f); process.exit(1); }
})();
