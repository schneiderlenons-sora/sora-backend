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
// ⚠️ DUAS TRAVAS, e as duas nasceram de casos reais que a simulação pegou:
//
//   1. SÓ CARTÃO DE CRÉDITO. O Itaú manda "Pagamento de capitalização CAP PIC
//      31/60" numa CONTA CORRENTE — tem marcador N/M mas é pagamento mensal de
//      um título, não parcela de compra. Deslocar isso destruiria 28 linhas.
//      (O sync não corre esse risco: a redistribuição vive em normalizeTxCartao
//      e essas linhas passam por normalizeTxConta.)
//
//   2. SÓ COMPRA COLAPSADA NUMA DATA SÓ. É essa a assinatura do bug da
//      Celcoin. Outro grupo da base já tem as parcelas espalhadas certinho
//      (jan/fev/mar/abr…) — provavelmente do trilho Pluggy, que data direito.
//      Deslocar de novo jogaria tudo anos pra frente.
//
// Além disso, só toca em linha que:
//   · veio do Open Finance (of_tx_id não nulo);
//   · tem marcador de parcela N/M na observação;
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

  // TRAVA 1 — só carteiras de CRÉDITO. Sem isso, "Pagamento de capitalização
  // CAP PIC 31/60" (conta corrente do Itaú) entraria como se fosse parcela.
  const wallets = [];
  for (let from = 0; ; from += 1000) {   // pagina aqui também (mesmo motivo)
    const { data, error: eW } = await supabase.from('wallets')
      .select('nome, grupo_id, tipo').order('id').range(from, from + 999);
    if (eW) { console.error('erro lendo wallets:', eW.message); process.exit(1); }
    wallets.push(...data);
    if (data.length < 1000) break;
  }
  const ehCredito = new Set(wallets
    .filter((w) => String(w.tipo || '').toLowerCase().startsWith('cr'))
    .map((w) => `${w.grupo_id}|${w.nome}`));
  console.log(`wallets lidas: ${wallets.length} (de crédito: ${ehCredito.size})`);

  // ⚠️ PAGINAR. O Supabase devolve no máximo 1000 linhas por request e não
  // avisa que truncou — sem isto o backfill processava só as primeiras 1000 e
  // deixava linhas erradas pra trás, em silêncio.
  const linhas = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from('transacoes')
      .select('id, grupo_id, data, observacao, valor, pago, parcela_num, of_tx_id, carteira_nome')
      .not('of_tx_id', 'is', null)
      .is('parcela_num', null)
      .order('id')
      .range(from, from + 999);
    if (ARG_GRUPO) q = q.eq('grupo_id', ARG_GRUPO);
    const { data, error } = await q;
    if (error) { console.error('erro lendo transacoes:', error.message); process.exit(1); }
    linhas.push(...data);
    if (data.length < 1000) break;
  }
  console.log('linhas OF sem parcela_num lidas:', linhas.length);

  // Agrupa por compra pra imprimir um relatório legível.
  const compras = new Map();
  let ignoradas = 0; let foraDeCartao = 0;

  for (const t of linhas) {
    const p = parcelaDaDescricao(t.observacao);
    if (!p) { ignoradas++; continue; }
    if (!ehCredito.has(`${t.grupo_id}|${t.carteira_nome}`)) { foraDeCartao++; continue; }

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

  // TRAVA 2 — só compra COLAPSADA numa data só (a assinatura do bug da
  // Celcoin). Parcelas já espalhadas pelos meses estão certas; deslocá-las de
  // novo jogaria tudo anos pra frente.
  // Exige 2+ linhas da MESMA compra na MESMA data. Grupo de 1 linha não serve
  // de prova: pode ser uma parcela já datada certo (o `parcela_grupo` inclui a
  // data, então parcelas corretamente espalhadas caem em grupos de 1 cada).
  // Sem prova do bug, não se escreve nada — nem a data, nem o metadado, que
  // sairia errado (cada parcela num grupo diferente).
  let semProva = 0;
  for (const [chave, c] of [...compras]) {
    const datas = new Set(c.itens.map((i) => i.de));
    if (c.itens.length < 2 || datas.size > 1) { compras.delete(chave); semProva += c.itens.length; }
  }

  let totalLinhas = 0; let totalMovidas = 0; let totalTiradoDoMes = 0;
  console.log(`compras parceladas a corrigir: ${compras.size}`);
  console.log(`(ignoradas: ${semProva} sem prova do bug · ${foraDeCartao} fora de cartão de crédito)\n`);

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
  console.log('linhas de parcela a corrigir ..', totalLinhas);
  console.log('linhas que mudam de data/pago .', totalMovidas);
  console.log('valor que sai do mês da compra.', brl(totalTiradoDoMes));
  console.log('linhas OF sem marcador (ok) ...', ignoradas);
  console.log('linhas protegidas pelas travas.', semProva + foraDeCartao);

  if (!APLICAR) {
    console.log('\nSimulação. Rode com --apply pra gravar.');
    return;
  }

  console.log('\ngravando...');
  let ok = 0; let erros = 0;
  for (const c of compras.values()) {
    for (const i of c.itens) {
      // `dataNova` undefined = linha solta: preenche só o metadado, não move.
      const patch = { parcela_num: i.n, parcela_total: i.total, parcela_grupo: i.grupo };
      if (i.dataNova) { patch.data = i.dataNova; patch.pago = i.pagoPara; }
      const { error: e } = await supabase.from('transacoes').update(patch).eq('id', i.id);
      if (e) { erros++; if (erros <= 3) console.error('  erro em', i.id, e.message); }
      else ok++;
    }
  }
  console.log(`atualizadas: ${ok} · erros: ${erros}`);
})();
