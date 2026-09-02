// =============================================================================
// TESTE DE INVARIÂNCIA — somente LEITURA, não escreve nada.
//
// Pega transações REAIS da base, aplica o rateio EM MEMÓRIA (exatamente como a
// rota faria) e confere que todas as somas do painel continuam idênticas:
//   · receitas / gastos / saldo do mês  (services/resumoTransacoes)
//   · a soma da fatura do cartão        (services/valorFatura)
//   · o total por categoria             (a única coisa que DEVE mudar)
//
// Se qualquer total mudar, o rateio está errado e não pode subir.
// =============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { montarRateio, motivoRecusa } = require('../src/services/rateio');
const { ehTransferencia } = require('../src/services/resumoTransacoes');
const { somarFatura } = require('../src/services/valorFatura');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY);
const c2 = (v) => Math.round((Number(v) || 0) * 100);

// As MESMAS contas do painel, reimplementadas aqui só pra comparar antes/depois.
function agregados(linhas) {
  let receitas = 0, gastos = 0;
  const porCat = {};
  for (const t of linhas) {
    if (ehTransferencia(t)) continue;
    if (t.tipo === 'Recebimento') receitas += c2(t.valor);
    else {
      gastos += c2(t.valor);
      porCat[t.categoria || '—'] = (porCat[t.categoria || '—'] || 0) + c2(t.valor);
    }
  }
  return { receitas, gastos, saldo: receitas - gastos, porCat };
}

let falhas = 0, testadas = 0;
const erro = (m) => { falhas++; console.log('   XX ' + m); };

(async () => {
  // Amostra ampla: pega transações de vários grupos e vários formatos.
  const { data: cands } = await sb.from('transacoes')
    .select('*').eq('tipo', 'Gasto').gte('valor', 20)
    .gte('data', '2026-07-01').order('valor', { ascending: false }).limit(400);

  const elegiveis = (cands || []).filter((t) => !motivoRecusa(t));
  console.log(`candidatas lidas: ${(cands || []).length} | elegíveis pro rateio: ${elegiveis.length}`);
  console.log(`recusadas (parcelada/moeda/transferência): ${(cands || []).length - elegiveis.length}\n`);

  // Testa 25 casos variados, um por grupo quando possível.
  const vistos = new Set();
  const amostra = [];
  for (const t of elegiveis) {
    const k = t.grupo_id;
    if (vistos.has(k) && amostra.length > 12) continue;
    vistos.add(k); amostra.push(t);
    if (amostra.length >= 25) break;
  }

  for (const tx of amostra) {
    testadas++;
    // Todas as transações do MÊS daquele grupo — o universo que o painel soma.
    const mes = String(tx.data).slice(0, 7);
    const { data: doMes } = await sb.from('transacoes')
      .select('*').eq('grupo_id', tx.grupo_id)
      .gte('data', `${mes}-01`).lt('data', `${mes}-32`).limit(2000);
    if (!doMes || !doMes.length) continue;

    const antes = agregados(doMes);

    // Divide em 3 partes desiguais, com o centavo de sobra na última.
    const total = c2(tx.valor);
    const p1 = Math.floor(total * 0.5), p2 = Math.floor(total * 0.3);
    const partes = [
      { categoria: 'Alimentação', valor: p1 / 100 },
      { categoria: 'Casa', valor: p2 / 100 },
      { categoria: 'Lazer', valor: (total - p1 - p2) / 100 },
    ];
    const r = montarRateio(tx, partes, 'grupo-teste');
    if (r.erro) { erro(`${tx.id}: montarRateio recusou — ${r.erro}`); continue; }

    // Substitui: tira a original, põe as partes (é o que a rota faz).
    const depoisLinhas = doMes.filter((t) => t.id !== tx.id).concat(r.linhas);
    const depois = agregados(depoisLinhas);

    if (antes.gastos !== depois.gastos) erro(`${tx.id}: GASTOS mudaram ${antes.gastos} → ${depois.gastos}`);
    if (antes.receitas !== depois.receitas) erro(`${tx.id}: RECEITAS mudaram`);
    if (antes.saldo !== depois.saldo) erro(`${tx.id}: SALDO do mês mudou`);
    if (depoisLinhas.length !== doMes.length + 2) erro(`${tx.id}: contagem de linhas errada`);

    // A soma por categoria TEM de mudar (é o objetivo), mas o total dela não.
    const somaCatAntes = Object.values(antes.porCat).reduce((a, b) => a + b, 0);
    const somaCatDepois = Object.values(depois.porCat).reduce((a, b) => a + b, 0);
    if (somaCatAntes !== somaCatDepois) erro(`${tx.id}: total por categoria mudou`);

    // Fatura: se for cartão, a soma assinada do ciclo não pode mudar.
    const doCartao = doMes.filter((t) => t.carteira_nome === tx.carteira_nome);
    const fAntes = somarFatura(doCartao);
    const fDepois = somarFatura(doCartao.filter((t) => t.id !== tx.id).concat(r.linhas));
    if (c2(fAntes) !== c2(fDepois)) erro(`${tx.id}: FATURA mudou ${fAntes} → ${fDepois}`);
  }

  console.log(`casos testados: ${testadas}`);
  console.log(falhas
    ? `\n✗ ${falhas} INVARIANTE(S) QUEBRADA(S) — não subir`
    : '\n✓ nenhuma soma mudou: gastos, receitas, saldo do mês, total por categoria e fatura permanecem idênticos');

  // Prova complementar: as recusas realmente pegam o que deveriam.
  const { data: parceladas } = await sb.from('transacoes').select('*').gt('parcela_total', 1).limit(5);
  const { data: estrangeiras } = await sb.from('transacoes').select('*').not('moeda', 'is', null).neq('moeda', 'BRL').limit(5);
  const { data: transfs } = await sb.from('transacoes').select('*').eq('transferencia', true).limit(5);
  const recusa = (arr, nome) => {
    const passou = (arr || []).filter((t) => !motivoRecusa(t)).length;
    console.log(`   ${nome}: ${(arr || []).length} testadas, ${passou} passariam ${passou ? '← FALHA' : '(todas recusadas, correto)'}`);
    if (passou) falhas++;
  };
  console.log('\nrecusas em dados reais:');
  recusa(parceladas, 'parceladas   ');
  recusa(estrangeiras, 'moeda estrang.');
  recusa(transfs, 'transferências');

  process.exit(falhas ? 1 : 0);
})();
