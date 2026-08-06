// =============================================================================
// BACKFILL: corrige as parcelas de cartão do Open Finance já importadas com a
// data da COMPRA em vez da data de COBRANÇA.
//
// POR QUE UM SCRIPT E NÃO UMA MIGRATION SQL: o `parcela_grupo` é um hash
// (sha1) calculado em JS. Reimplementar isso em PL/pgSQL geraria grupos
// DIFERENTES dos que o sync gera daqui pra frente — as parcelas antigas e as
// novas da mesma compra cairiam em grupos distintos. Aqui reusamos as funções
// EXATAS do serviço, então o resultado é idêntico ao do sync.
//
// Só toca em linha que:
//   · veio do Open Finance (of_tx_id não nulo);
//   · tem marcador de parcela N/M na observação com N > 1;
//   · ainda NÃO foi corrigida (parcela_num nulo) → idempotente.
//
// Uso:
//   node scripts/backfill-parcelas-of.js            # simulação (não grava)
//   node scripts/backfill-parcelas-of.js --apply    # grava
//   node scripts/backfill-parcelas-of.js --grupo=<uuid>   # limita a um grupo
// =============================================================================
require('dotenv').config();
const supabase = require('../src/db/supabase');
const {
  parcelaDaDescricao, dataDaParcela, grupoDaParcela,
} = require('../src/services/polpCelcoinSync');
const { hojeSP } = require('../src/services/cicloFatura');

const APLICAR = process.argv.includes('--apply');
const ARG_GRUPO = (process.argv.find((a) => a.startsWith('--grupo=')) || '').split('=')[1];
const brl = (v) => `R$ ${Number(v).toFixed(2)}`;
// ⚠️ Dia no fuso de SÃO PAULO, não em UTC: uma compra às 21h no Brasil já é o
// dia seguinte em UTC e o relatório mostraria um dia a mais do que a fatura.
const dia = (d) => (d ? new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) : '');

(async () => {
  const hoje = hojeSP();
  console.log(APLICAR ? '⚠️  MODO GRAVAÇÃO' : '🔍 SIMULAÇÃO (nada será gravado)');
  console.log('hoje (SP):', hoje, '\n');

  let q = supabase.from('transacoes')
    .select('id, grupo_id, data, observacao, valor, pago, parcela_num, of_tx_id')
    .not('of_tx_id', 'is', null)
    .is('parcela_num', null);
  if (ARG_GRUPO) q = q.eq('grupo_id', ARG_GRUPO);

  const { data: linhas, error } = await q;
  if (error) { console.error('erro lendo transacoes:', error.message); process.exit(1); }

  // Agrupa por compra pra imprimir um relatório legível.
  const compras = new Map();
  let ignoradas = 0;

  for (const t of linhas) {
    const p = parcelaDaDescricao(t.observacao);
    if (!p) { ignoradas++; continue; }

    const grupo = grupoDaParcela(p.base, p.total, Math.abs(Number(t.valor)), t.data);
    // A data ATUAL da linha é a data da compra (é justamente o bug).
    const novaData = p.n > 1 ? dataDaParcela(t.data, p.n) : t.data;
    const novoPago = !(dia(novaData) > hoje);

    const chave = `${t.grupo_id}|${grupo}`;
    if (!compras.has(chave)) compras.set(chave, { grupo_id: t.grupo_id, base: p.base, total: p.total, itens: [] });
    compras.get(chave).itens.push({
      id: t.id, n: p.n, total: p.total, valor: Number(t.valor),
      // `novaData` já vem calculada pelo serviço (que resolve o fuso). Guardo
      // o valor CRU pra gravar — fatiar e recalcular reintroduziria o bug.
      dataNova: novaData,
      de: dia(t.data), para: dia(novaData), pagoDe: t.pago, pagoPara: novoPago,
      grupo, mudou: dia(novaData) !== dia(t.data) || novoPago !== t.pago,
    });
  }

  let totalLinhas = 0; let totalMovidas = 0; let totalTiradoDoMes = 0;
  console.log(`compras parceladas encontradas: ${compras.size}\n`);

  for (const c of [...compras.values()].sort((a, b) => b.itens.length - a.itens.length)) {
    const movidas = c.itens.filter((i) => i.mudou);
    totalLinhas += c.itens.length;
    totalMovidas += movidas.length;
    totalTiradoDoMes += movidas.reduce((s, i) => s + i.valor, 0);
    console.log(`• ${c.base}  (${c.itens.length} linhas de ${c.total}x)`);
    for (const i of c.itens.sort((a, b) => a.n - b.n)) {
      const marca = i.mudou ? '→' : ' =';
      const pago = i.pagoDe !== i.pagoPara ? `  pago ${i.pagoDe}→${i.pagoPara}` : '';
      console.log(`    ${String(i.n).padStart(2)}/${i.total}  ${brl(i.valor).padStart(10)}  ${i.de} ${marca} ${i.para}${pago}`);
    }
    console.log('');
  }

  console.log('─'.repeat(60));
  console.log('linhas de parcela analisadas ..', totalLinhas);
  console.log('linhas que mudam de data/pago .', totalMovidas);
  console.log('valor que sai do mês da compra.', brl(totalTiradoDoMes));
  console.log('linhas OF sem marcador (ok) ...', ignoradas);

  if (!APLICAR) {
    console.log('\nSimulação. Rode com --apply pra gravar.');
    return;
  }

  console.log('\ngravando...');
  let ok = 0; let erros = 0;
  for (const c of compras.values()) {
    for (const i of c.itens) {
      const { error: e } = await supabase.from('transacoes').update({
        data: i.dataNova,
        pago: i.pagoPara,
        parcela_num: i.n,
        parcela_total: i.total,
        parcela_grupo: i.grupo,
      }).eq('id', i.id);
      if (e) { erros++; if (erros <= 3) console.error('  erro em', i.id, e.message); }
      else ok++;
    }
  }
  console.log(`atualizadas: ${ok} · erros: ${erros}`);
})();
