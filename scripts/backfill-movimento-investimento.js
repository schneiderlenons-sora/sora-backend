// =============================================================================
// Aplicação/resgate de investimento que ficou contado como despesa/receita.
//
// Aplicar R$ 1.000 num CDB não é gastar R$ 1.000 — o dinheiro sai do bolso
// "conta" e entra no bolso "investimento". O patrimônio é o mesmo. Resgatar é
// o caminho de volta, e também não é renda.
//
// MEDIDO antes de escrever (base inteira, ago/2026):
//   264 aplicações contavam R$ 126.769,69 como DESPESA
//   409 resgates   contavam R$ 101.377,01 como RECEITA
// Quem usa Cofrinho do Inter ou CDB de liquidez diária tinha o relatório
// distorcido: um cliente com 132 aplicações inflava os DOIS lados a cada ciclo
// de entra-e-sai na mesma conta.
//
// ⚠️ RENDIMENTO, DIVIDENDO E IMPOSTO NÃO SÃO TOCADOS. Esses mudam o patrimônio
// de verdade (rendeu = ganhou; IR = perdeu) e continuam como receita/despesa.
// Quem separa é `ehMovimentoInvestimento`, com eval próprio — em particular ele
// barra "REMUNERACAO APLICACAO AUTOMATICA" e "RENTAB.INVEST FACIL", que contêm
// a palavra "aplicação" mas são RENDA. Transformá-las em transferência apagaria
// o ganho do usuário sem ele nunca saber.
//
// ⚠️ SCRIPT E NÃO MIGRATION SQL, pelo mesmo motivo do
// backfill-pagamento-fatura-conta.js: a regra é delicada e reescrevê-la em SQL
// criaria uma segunda verdade. Aqui ela é IMPORTADA.
//
// ⚠️ SÓ CARTEIRA QUE NÃO É CARTÃO. Não existe "aplicar" a partir de um cartão
// de crédito, e marcar transferência em carteira de crédito mexeria no cálculo
// da fatura (`valorFatura.valorNaFatura`). Medido: as 612 linhas candidatas
// estão todas em Corrente/Poupança — nenhuma em cartão. O filtro fica como
// trava, não como formalidade.
//
// Uso:
//   node scripts/backfill-movimento-investimento.js           (simulação)
//   node scripts/backfill-movimento-investimento.js --aplicar (grava)
// =============================================================================
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { ehMovimentoInvestimento } = require('../src/services/categorizar');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const APLICAR = process.argv.includes('--aplicar');
const money = (n) => Number(n || 0).toFixed(2).padStart(12);
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
  for (const w of wallets) tipoDaCarteira[chave(w.grupo_id, w.nome)] = w.tipo;

  const tx = await tudo('transacoes',
    'id, grupo_id, tipo, valor, data, observacao, categoria, carteira_nome, transferencia');
  console.log(`transações lidas: ${tx.length}\n`);

  const alvo = tx.filter((t) =>
    t.transferencia !== true
    && tipoDaCarteira[chave(t.grupo_id, t.carteira_nome)] !== 'Crédito'
    && ehMovimentoInvestimento(t.observacao || '', t.categoria || ''));

  // Separa por direção só pra leitura do relatório.
  const saidas  = alvo.filter((t) => t.tipo === 'Gasto');
  const entradas = alvo.filter((t) => t.tipo === 'Recebimento');

  console.log('═══ VIRAM TRANSFERÊNCIA ═══');
  console.log(`  aplicações (hoje DESPESA): ${String(saidas.length).padStart(4)}  R$ ${saidas.reduce((s, t) => s + +t.valor, 0).toFixed(2)}`);
  console.log(`  resgates   (hoje RECEITA): ${String(entradas.length).padStart(4)}  R$ ${entradas.reduce((s, t) => s + +t.valor, 0).toFixed(2)}`);

  // Descrições distintas — é aqui que um falso positivo aparece a olho nu.
  const desc = {};
  for (const t of alvo) {
    const k = String(t.observacao || '(sem descrição)').slice(0, 46);
    desc[k] = desc[k] || { n: 0, v: 0 };
    desc[k].n++; desc[k].v += +t.valor;
  }
  console.log('\n  descrições distintas:', Object.keys(desc).length);
  for (const [d, x] of Object.entries(desc).sort((a, b) => b[1].n - a[1].n)) {
    console.log('   ', String(x.n).padStart(4) + 'x', money(x.v), '|', d);
  }

  // Por grupo — pra dimensionar quem sente a mudança.
  const porGrupo = {};
  for (const t of alvo) porGrupo[t.grupo_id] = (porGrupo[t.grupo_id] || 0) + 1;
  console.log('\n  grupos afetados:', Object.keys(porGrupo).length);

  if (!APLICAR) {
    console.log('\nSIMULAÇÃO — nada foi gravado. Rode com --aplicar para valer.');
    return;
  }

  // ⚠️ A CATEGORIA NÃO É TOCADA. Ela já diz "Investimentos"/"Resgate", que é
  // informação melhor que "Transferências" — a flag sozinha já tira do cálculo
  // de receita/despesa, nos dois lados (backend `resumoTransacoes.ehTransferencia`
  // e o porte fiel em `lib/ssr-data.ts` do painel).
  let ok = 0;
  for (const t of alvo) {
    const { error } = await sb.from('transacoes').update({ transferencia: true }).eq('id', t.id);
    if (error) console.error('  ❌', t.id, error.message);
    else ok++;
  }
  console.log(`\n✅ ${ok}/${alvo.length} linha(s) marcadas como transferência.`);
})().catch((e) => { console.error('erro:', e.message); process.exit(1); });
