// =============================================================================
// EVAL — ajuste de saldo NÃO é receita nem despesa.
//
// Caso real (set/2026): o cliente acertou o saldo da conta PJ com o banco e o
// painel passou a mostrar R$ 3.485,18 de "receita" no mês. Medido na base: 60
// ajustes em 27 grupos; em setembro, 11 grupos com receitas −R$ 13.507,57 e
// despesas −R$ 2.265,97.
//
// O que este eval trava:
//   1. `ehAjusteSaldo` casa "Ajuste" e "Ajuste recebido" com qualquer ícone,
//      caixa ou acento — e NADA além disso ("Ajuste de roupa" é gasto).
//   2. O resumo do mês (dashboard, relatórios, categorias) e o do ano deixam o
//      ajuste fora dos totais E da quebra por categoria/membro — os dois lados
//      tirando juntos, senão o card e a aba Categorias divergem (migration 135).
//   3. O resumo semanal/mensal do WhatsApp segue a mesma regra.
//   4. Tudo que não é ajuste soma exatamente como antes.
//
// Rodar:  npm run eval:ajuste-saldo
// =============================================================================
const path = require('path');
// resumoFinanceiro instancia o cliente da OpenAI ao carregar; nada aqui chama a IA.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-eval-sem-rede';

function fakeSupabase(linhas) {
  function from(tabela) {
    const filtros = [];
    const api = {
      select() { return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      gte(c, v) { filtros.push((r) => String(r[c]) >= v); return api; },
      lt(c, v) { filtros.push((r) => String(r[c]) < v); return api; },
      in(c, arr) { filtros.push((r) => arr.includes(r[c])); return api; },
      is() { return api; },
      then(ok, erro) {
        const base = tabela === 'transacoes' ? linhas : [];
        return Promise.resolve({ data: base.filter((r) => filtros.every((f) => f(r))), error: null }).then(ok, erro);
      },
    };
    return api;
  }
  return { from };
}

const raiz = path.resolve(__dirname, '../src');
function carregar(linhas) {
  for (const k of Object.keys(require.cache)) if (k.startsWith(raiz)) delete require.cache[k];
  const fixar = (rel, exports) => {
    const f = path.join(raiz, rel);
    require.cache[f] = { id: f, filename: f, loaded: true, exports };
  };
  fixar('db/supabase.js', fakeSupabase(linhas));
  fixar('services/arquivadas.js', { filtrar: async (q) => q });
  return {
    resumo: require(path.join(raiz, 'services/resumoTransacoes.js')),
    financeiro: require(path.join(raiz, 'services/resumoFinanceiro.js')),
    categorizar: require(path.join(raiz, 'services/categorizar.js')),
  };
}

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const cent = (n) => Math.round(n * 100) / 100;

const G = 'g1';
const LINHAS = [
  { grupo_id: G, data: '2026-09-04', tipo: 'Recebimento', valor: 2796, categoria: '🛠️ Venda de serviços', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-09-08', tipo: 'Recebimento', valor: 5700, categoria: '🛠️ Venda de serviços', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-09-14', tipo: 'Recebimento', valor: 3485.18, categoria: '🔧 Ajuste recebido', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-09-10', tipo: 'Gasto', valor: 300, categoria: '🔧 Ajuste', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-09-10', tipo: 'Gasto', valor: 505.87, categoria: '🏦 Ajuste', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-09-06', tipo: 'Gasto', valor: 2610.82, categoria: 'Plano de saúde', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-09-11', tipo: 'Gasto', valor: 80, categoria: 'Ajuste de roupa', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-09-12', tipo: 'Gasto', valor: 2500, categoria: 'Transferências', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-09-13', tipo: 'Gasto', valor: 900, categoria: 'Fatura', criado_por: 'u1', transferencia: true },
  { grupo_id: G, data: '2026-08-20', tipo: 'Gasto', valor: 1000, categoria: '🔧 Ajuste', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-08-20', tipo: 'Gasto', valor: 50, categoria: 'Mercado', criado_por: 'u1', transferencia: false },
];

(async () => {
  console.log('── 1. o que é ajuste ──');
  {
    const { ehAjusteSaldo } = carregar([]).categorizar;
    for (const s of ['🔧 Ajuste', '🔧 Ajuste recebido', '🏦 Ajuste', 'Ajuste', 'AJUSTE RECEBIDO', '  ajuste  ', 'Ajuste  recebido']) {
      eq(ehAjusteSaldo(s), true, `"${s}" é ajuste`);
    }
    for (const s of ['Ajuste de roupa', 'Reajuste', 'Ajustes', 'Ajuste pago', 'Ajuste 2', 'Outros', 'Fatura', '', null, undefined, 'Transferências']) {
      eq(ehAjusteSaldo(s), false, `"${s}" NÃO é ajuste`);
    }
  }
  console.log('  ok');

  console.log('── 2. resumo do mês: fora dos totais E das quebras ──');
  {
    const { resumo } = carregar(LINHAS);
    const r = await resumo.calcularResumo({ grupoId: G, mes: '2026-09' });
    eq(cent(r.receitas), 8496, '⚠️ receitas = 2.796 + 5.700 (sem os 3.485,18 do ajuste)');
    eq(cent(r.gastos), 2690.82, 'gastos = plano 2.610,82 + "Ajuste de roupa" 80 (sem os dois ajustes, transferência e fatura)');
    eq(cent(r.saldo), cent(8496 - 2690.82), 'saldo = receitas − gastos');
    eq(r.por_categoria.some((c) => /ajuste$/i.test(c.categoria)), false, 'categoria Ajuste some da quebra de gastos');
    eq(r.por_categoria_receitas.some((c) => /ajuste recebido/i.test(c.categoria)), false, 'Ajuste recebido some da quebra de receitas');
    eq(r.por_categoria.find((c) => c.categoria === 'Ajuste de roupa')?.total, 80, '"Ajuste de roupa" segue como gasto');
    const somaCat = cent(r.por_categoria.reduce((s, c) => s + c.total, 0));
    eq(somaCat, cent(r.gastos), '⚠️ soma das categorias = total de gastos (card × aba Categorias)');
    const somaRec = cent(r.por_categoria_receitas.reduce((s, c) => s + c.total, 0));
    eq(somaRec, cent(r.receitas), 'soma das categorias de receita = total de receitas');
    eq(cent(r.por_membro[0].receitas), 8496, 'por membro também sem o ajuste');
    eq(resumo.ehTransferencia({ categoria: '🔧 Ajuste recebido', transferencia: false }), true, 'ehTransferencia (fonte única) reconhece o ajuste');
    eq(resumo.ehTransferencia({ categoria: 'Mercado', transferencia: false }), false, 'e não o resto');
  }
  console.log('  ok');

  console.log('── 3. resumo do ano ──');
  {
    const { resumo } = carregar(LINHAS);
    const a = await resumo.calcularResumoAnual({ grupoId: G, ano: 2026 });
    eq(cent(a.meses[7].gastos), 50, 'agosto: só o mercado (o ajuste de 1.000 sai)');
    eq(cent(a.meses[8].receitas), 8496, 'setembro: receitas sem ajuste');
    eq(cent(a.meses[8].gastos), 2690.82, 'setembro: gastos iguais ao resumo do mês');
  }
  console.log('  ok');

  console.log('── 4. resumo do WhatsApp ──');
  {
    const { financeiro } = carregar(LINHAS);
    const p = await financeiro.resumoPeriodo(G, '2026-09-01', '2026-10-01');
    eq(cent(p.receitas), 8496, 'receitas da semana/mês sem ajuste');
    eq(p.topCats.some(([nome]) => /^ajuste$/i.test(String(nome).trim())), false, 'Ajuste não vira "categoria que mais pesou"');
  }
  console.log('  ok');

  console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
  if (falhas.length) { falhas.forEach((f) => console.log('  · ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
