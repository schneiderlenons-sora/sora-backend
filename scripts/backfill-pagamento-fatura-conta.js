// =============================================================================
// Pagamento de fatura DEBITADO NA CONTA que ficou contado como DESPESA.
//
// Relato (davidmquinlan@mac.com, 29/08/2026): "importei o extrato e os números
// das minhas entradas e saídas dispararam". Investigado: a conta dele NÃO tinha
// duplicação relevante de importação (9 linhas, R$ 1.025). O que inflava era
// pagamento de fatura de cartão entrando como gasto comum — enquanto CADA
// COMPRA daquele cartão já estava contada uma a uma. O mesmo dinheiro, duas
// vezes.
//
// ⚠️ POR QUE ISTO É UM SCRIPT E NÃO UMA MIGRATION SQL.
// A regra de "isto é pagamento de fatura?" já existe e é delicada:
// `ehPagamentoFaturaDescricao` (services/categorizar.js), afinada ao longo das
// migrations 119, 124 e 127. Reescrevê-la em SQL criaria uma SEGUNDA verdade,
// que diverge da primeira no dia em que alguém ajustar uma das duas. Aqui ela é
// importada, não copiada.
//
// ⚠️ O CÓDIGO NOVO JÁ ESTÁ CERTO. `normalizeTxConta` no polpCelcoinSync marca
// esses lançamentos como transferência desde sempre. O problema é HISTÓRICO: o
// sync NUNCA reescreve linha existente (proteção deliberada da categoria
// corrigida à mão), então quem importou antes — ou editou a descrição depois —
// ficou com o gasto de pé.
//
// ─── A GUARDA QUE IMPEDE O ESTRAGO ──────────────────────────────────────────
//
// Pagamento de fatura só é contagem DUPLA se as compras do cartão estiverem no
// sistema. Se a pessoa conectou/importou SÓ a conta corrente, esse pagamento é
// o ÚNICO registro daquele consumo — convertê-lo em transferência faria a
// despesa sumir sem nada no lugar.
//
// MEDIDO antes de escrever: das 6 linhas candidatas na base, 2 são exatamente
// esse caso (R$ 28.457,33 de um cliente cujo cartão não tem NENHUMA compra
// lançada). Elas são preservadas. Só convertem as 4 de quem tem as compras.
//
// Uso:
//   node scripts/backfill-pagamento-fatura-conta.js           (simulação)
//   node scripts/backfill-pagamento-fatura-conta.js --aplicar (grava)
// =============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { ehPagamentoFaturaDescricao, CATEGORIA_FATURA } = require('../src/services/categorizar');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const APLICAR = process.argv.includes('--aplicar');
const money = (n) => Number(n || 0).toFixed(2).padStart(11);
const chave = (g, nome) => `${g}|${String(nome || '').toLowerCase().trim()}`;

async function tudo(tabela, colunas) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(tabela).select(colunas).range(from, from + 999);
    if (error) throw new Error(`${tabela}: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

(async () => {
  const wallets = await tudo('wallets', 'grupo_id, nome, tipo');
  const tipoDaCarteira = {};
  const cartoesDoGrupo = {};
  for (const w of wallets) {
    tipoDaCarteira[chave(w.grupo_id, w.nome)] = w.tipo;
    if (w.tipo === 'Crédito') {
      (cartoesDoGrupo[w.grupo_id] = cartoesDoGrupo[w.grupo_id] || []).push(String(w.nome || '').toLowerCase().trim());
    }
  }

  const tx = await tudo('transacoes',
    'id, grupo_id, tipo, valor, data, observacao, categoria, carteira_nome, transferencia, of_tx_id');
  console.log(`transações lidas: ${tx.length}\n`);

  // Candidatas: gasto, ainda não marcado como transferência, numa carteira que
  // NÃO é cartão (no cartão a quitação tem tratamento próprio), cuja descrição
  // a regra canônica reconhece como pagamento de fatura.
  const candidatas = tx.filter((t) =>
    t.tipo === 'Gasto'
    && t.transferencia !== true
    && tipoDaCarteira[chave(t.grupo_id, t.carteira_nome)] !== 'Crédito'
    && ehPagamentoFaturaDescricao(t.observacao || '', t.categoria || ''));

  // Guarda: as compras daquele cartão existem no MESMO mês?
  const temCompras = (t) => {
    const mes = String(t.data).slice(0, 7);
    const cartoes = cartoesDoGrupo[t.grupo_id] || [];
    if (!cartoes.length) return false;
    return tx.some((x) => x.grupo_id === t.grupo_id
      && x.tipo === 'Gasto' && x.transferencia !== true
      && String(x.data).slice(0, 7) === mes
      && cartoes.includes(String(x.carteira_nome || '').toLowerCase().trim()));
  };

  const converter = candidatas.filter(temCompras);
  const preservar = candidatas.filter((t) => !temCompras(t));

  console.log('═══ CONVERTER em transferência (contagem dupla comprovada) ═══');
  for (const t of converter.sort((a, b) => b.valor - a.valor)) {
    console.log(' ', String(t.data).slice(0, 10), money(t.valor),
      '|', String(t.carteira_nome || '-').slice(0, 20).padEnd(21),
      '|', String(t.observacao || '').slice(0, 44));
  }
  console.log(`  → ${converter.length} linha(s), R$ ${converter.reduce((s, t) => s + +t.valor, 0).toFixed(2)}\n`);

  console.log('═══ PRESERVAR como gasto (o cartão não tem compras lançadas) ═══');
  for (const t of preservar.sort((a, b) => b.valor - a.valor)) {
    console.log(' ', String(t.data).slice(0, 10), money(t.valor),
      '|', String(t.observacao || '').slice(0, 44));
  }
  console.log(`  → ${preservar.length} linha(s), R$ ${preservar.reduce((s, t) => s + +t.valor, 0).toFixed(2)}`);
  console.log('    (converter estas APAGARIA a despesa sem nada no lugar)\n');

  if (!APLICAR) {
    console.log('SIMULAÇÃO — nada foi gravado. Rode com --aplicar para valer.');
    return;
  }

  let ok = 0;
  for (const t of converter) {
    const { error } = await sb.from('transacoes')
      .update({ transferencia: true, categoria: CATEGORIA_FATURA })
      .eq('id', t.id);
    if (error) console.error('  ❌', t.id, error.message);
    else ok++;
  }
  console.log(`✅ ${ok}/${converter.length} linha(s) convertidas.`);
})().catch((e) => { console.error('erro:', e.message); process.exit(1); });
