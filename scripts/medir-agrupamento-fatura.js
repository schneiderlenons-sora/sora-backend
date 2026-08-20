// =============================================================================
// MEDIÇÃO (read-only) — agrupar a fatura pela atribuição do BANCO
//
// Etapa 1 da melhoria adiada: quantificar o que mudaria SE a lista de
// lançamentos de cada fatura passasse a sair de `of_bill_id` (a fatura a que o
// EMISSOR vinculou a linha) em vez do nosso ciclo de datas.
//
// ⚠️ NÃO ESCREVE NADA. Só lê e compara.
//
// ── O PROBLEMA ───────────────────────────────────────────────────────────────
// O banco agrupa pela data em que a compra foi LANÇADA na fatura
// (`bill_post_date`), não pela data da COMPRA. Uma compra do dia 04 processada
// no dia 09 entra na fatura seguinte — e nenhuma regra de data prevê isso.
// Resultado: o cliente vê o total certo (vem de `bill_total_amount`) e os
// lançamentos embaixo somando outra coisa.
//
// ── O QUE ESTE SCRIPT RESPONDE ───────────────────────────────────────────────
//   · quantas faturas mudariam de lista, por cartão e por cliente;
//   · quantas linhas trocariam de fatura, e quanto em dinheiro;
//   · quanto a SOMA DA LISTA se aproximaria (ou não) do total que o banco
//     publicou — que é a razão de ser da mudança;
//   · quantos cartões NÃO têm `of_bill_id` e continuariam no ciclo (o fallback).
//
// Rodar:  node scripts/medir-agrupamento-fatura.js
// =============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { cicloPorCompetencia } = require('../src/services/cicloFatura');
const { somarFatura } = require('../src/services/valorFatura');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const esc = (s) => String(s).replace(/([%_])/g, '\\$1');
const money = (v) => `R$ ${Number(v || 0).toFixed(2)}`;
const cent = (v) => Math.round((Number(v) || 0) * 100) / 100;

(async () => {
  const { data: users } = await sb.from('users').select('email, grupo_ativo');
  const dono = {};
  (users || []).forEach((u) => { if (u.grupo_ativo && !dono[u.grupo_ativo]) dono[u.grupo_ativo] = u.email; });

  const { data: cartoes } = await sb.from('wallets')
    .select('id, nome, grupo_id, dia_fechamento, dia_vencimento')
    .eq('tipo', 'Crédito').not('of_conta_id', 'is', null);

  const semBillId = [];
  const linhasRelatorio = [];
  let totFaturas = 0, totDivergentes = 0, totLinhas = 0, totDinheiro = 0;
  let aproximou = 0, afastou = 0, igual = 0;
  let hibAprox = 0, hibAfasta = 0, hibIgual = 0;
  let postAprox = 0, postAfasta = 0, postIgual = 0;
  let temPostDate = true;   // vira false se a 130 ainda não rodou

  for (const c of cartoes || []) {
    // ⚠️ Leitura tolerante: `of_bill_post_date` é da migration 130. Pedir uma
    // coluna que não existe faz o select INTEIRO falhar e o script mede ZERO —
    // foi o que aconteceu na primeira execução.
    const COLS = 'data, valor, tipo, transferencia, categoria, observacao, of_bill_id';
    let { data: txs, error: eTx } = await sb.from('transacoes')
      .select(`${COLS}, of_bill_post_date`)
      .eq('grupo_id', c.grupo_id).ilike('carteira_nome', esc(c.nome));
    if (eTx) {
      temPostDate = false;
      ({ data: txs } = await sb.from('transacoes').select(COLS)
        .eq('grupo_id', c.grupo_id).ilike('carteira_nome', esc(c.nome)));
    }

    const comBill = (txs || []).filter((t) => t.of_bill_id);
    if (!comBill.length || !c.dia_fechamento) {
      semBillId.push(`${(dono[c.grupo_id] || '?').slice(0, 24).padEnd(25)} ${String(c.nome).slice(0, 26)}`);
      continue;
    }

    const { data: fats } = await sb.from('of_faturas')
      .select('competencia, total, of_bill_id').eq('cartao_id', c.id);

    for (const f of fats || []) {
      if (!f.of_bill_id) continue;
      const doBanco = comBill.filter((t) => t.of_bill_id === f.of_bill_id);
      if (!doBanco.length) continue;
      totFaturas++;

      const ciclo = cicloPorCompetencia(c, f.competencia);
      const noCiclo = (txs || []).filter((t) => {
        const d = String(t.data).slice(0, 10);
        return d >= ciclo.ini && d < ciclo.fimExcl;
      });

      // As que trocariam de fatura, nos dois sentidos.
      const chave = (t) => `${t.data}|${t.valor}|${t.observacao}`;
      const setCiclo = new Set(noCiclo.map(chave));
      const setBanco = new Set(doBanco.map(chave));
      const entram = doBanco.filter((t) => !setCiclo.has(chave(t)));   // banco põe, ciclo não
      const saem   = noCiclo.filter((t) => !setBanco.has(chave(t)));   // ciclo põe, banco não
      if (!entram.length && !saem.length) continue;

      totDivergentes++;
      totLinhas += entram.length + saem.length;
      const dinheiro = [...entram, ...saem].reduce((s, t) => s + Math.abs(Number(t.valor) || 0), 0);
      totDinheiro += dinheiro;

      // ⭐ O QUE DECIDE SE VALE A PENA: a soma da lista fica mais perto do total
      // que o banco publicou? Se não ficar, a mudança é cosmética.
      const somaCiclo = somarFatura(noCiclo);
      const somaBanco = somarFatura(doBanco);
      // ⭐ VARIANTE HÍBRIDA — a que tem chance de funcionar de verdade.
      // Só ~14% das linhas chegam com `of_bill_id` (o emissor só vincula
      // depois do fechamento), então usar SÓ a atribuição do banco DESCARTA o
      // resto e a fatura sai menor. O híbrido usa o banco onde ele opinou e o
      // ciclo onde ele calou:
      //   linhas com of_bill_id == esta fatura  ∪  linhas SEM of_bill_id no ciclo
      const semBill = noCiclo.filter((t) => !t.of_bill_id);
      const somaHibrida = somarFatura([...doBanco, ...semBill]);

      // ⭐ VARIANTE 3 — híbrido + `bill_post_date` (migration 130).
      // O que sobra de erro no híbrido são as linhas SEM vínculo, que ainda são
      // agrupadas pela data da COMPRA. `bill_post_date` é a data em que o
      // emissor LANÇOU a compra na fatura — a que ele mesmo usa pra decidir.
      // Só entra em quem tiver o campo; sem ele, cai na data da compra.
      const noCicloPorPost = (txs || []).filter((t) => {
        const d = String(t.of_bill_post_date || t.data).slice(0, 10);
        return d >= ciclo.ini && d < ciclo.fimExcl;
      });
      const semBillPost = noCicloPorPost.filter((t) => !t.of_bill_id);
      const somaPost = somarFatura([...doBanco, ...semBillPost]);
      const alvo = Number(f.total) || 0;
      const antes = Math.abs(cent(somaCiclo - alvo));
      const depois = Math.abs(cent(somaBanco - alvo));
      const depoisHib = Math.abs(cent(somaHibrida - alvo));
      const depoisPost = Math.abs(cent(somaPost - alvo));
      if (alvo > 0) {
        if (depois < antes - 0.01) aproximou++;
        else if (depois > antes + 0.01) afastou++;
        else igual++;
        if (depoisHib < antes - 0.01) hibAprox++;
        else if (depoisHib > antes + 0.01) hibAfasta++;
        else hibIgual++;
        if (depoisPost < antes - 0.01) postAprox++;
        else if (depoisPost > antes + 0.01) postAfasta++;
        else postIgual++;
      }

      linhasRelatorio.push({
        cliente: dono[c.grupo_id] || '?',
        cartao: c.nome,
        competencia: f.competencia,
        totalBanco: alvo,
        somaCiclo: cent(somaCiclo),
        somaBanco: cent(somaBanco),
        entram: entram.length,
        saem: saem.length,
        dinheiro: cent(dinheiro),
        somaHibrida: cent(somaHibrida),
        somaPost: cent(somaPost),
        antes, depois, depoisHib, depoisPost,
      });
    }
  }

  console.log('═══ ETAPA 1 — O QUE MUDARIA (nada foi escrito) ═══\n');
  console.log(`cartões de Open Finance ............ ${(cartoes || []).length}`);
  console.log(`  sem of_bill_id (seguem no ciclo) . ${semBillId.length}`);
  console.log(`faturas conferíveis ................ ${totFaturas}`);
  console.log(`  que mudariam de lista ............ ${totDivergentes}`);
  console.log(`  linhas que trocariam de fatura ... ${totLinhas}  (${money(totDinheiro)} em jogo)`);
  console.log('');
  console.log('A LISTA FICARIA MAIS PERTO DO TOTAL DO BANCO?');
  console.log('');
  console.log('  (A) SÓ o que o banco vinculou:');
  console.log(`        aproximou ${aproximou} · igual ${igual} · AFASTOU ${afastou}`);
  console.log('  (B) HÍBRIDO — banco onde ele opinou, ciclo onde ele calou:');
  console.log(`        aproximou ${hibAprox} · igual ${hibIgual} · AFASTOU ${hibAfasta}`);
  console.log('  (C) HÍBRIDO + bill_post_date (migration 130):');
  if (!temPostDate) {
    console.log('        (migration 130 ainda não rodou — sem dado pra medir)');
  } else {
    console.log(`        aproximou ${postAprox} · igual ${postIgual} · AFASTOU ${postAfasta}`);
  }

  console.log('\n─── DETALHE POR FATURA ───');
  console.log('cliente                   cartão                comp     total banco   soma hoje     só banco     híbrido');
  linhasRelatorio
    .sort((a, b) => (b.antes - b.depoisHib) - (a.antes - a.depoisHib))
    .forEach((l) => {
      const marca = (d) => (d < l.antes - 0.01 ? '✓' : (d > l.antes + 0.01 ? '✗' : '='));
      console.log(
        `${String(l.cliente).slice(0, 24).padEnd(25)} ${String(l.cartao).slice(0, 20).padEnd(21)} ${l.competencia}  `
        + `${money(l.totalBanco).padStart(12)} ${money(l.somaCiclo).padStart(12)} `
        + `${marca(l.depois)}${money(l.somaBanco).padStart(12)} ${marca(l.depoisHib)}${money(l.somaHibrida).padStart(12)}`);
    });

  console.log('\n─── CARTÕES QUE CONTINUARIAM NO CICLO (sem of_bill_id) ───');
  semBillId.forEach((s) => console.log('  ' + s));
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
