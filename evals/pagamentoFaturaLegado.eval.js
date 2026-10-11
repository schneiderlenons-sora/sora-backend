// =============================================================================
// EVAL — pagamento de fatura categorizado "Cartão de Credito" NÃO é consumo.
//
// Caso real (out/2026, cliente Vander): no relatório, as categorias de consumo
// (combustível, farmácia, supermercado) vinham "muito abaixo" e pareciam mostrar
// só o débito. Medido na base dele: o crédito APARECE certo; o que afogava a
// análise era o PAGAMENTO DA FATURA — 10 linhas num débito, descrições
// "CardBankslip"/"Fatura Carão Crédito BTG"/"Banco Inter S.A." — categorizado
// "Cartão de Credito" e contado como GASTO. Isso é contagem em DOBRO (as compras
// da fatura já são lançadas uma a uma) e virava a categoria #1 do mês. Medido na
// base inteira: a categoria só existe em 1 grupo, e as 10 linhas são TODAS
// pagamento de fatura.
//
// O que este eval trava:
//   1. `ehPagamentoFaturaLegado` casa "Cartão de Credito"/"Cartão de Crédito"
//      com qualquer caixa/acento — e NADA além ("Cartão", "Crédito", "Cartão de
//      débito", "Fatura" NÃO casam).
//   2. O resumo do mês (relatórios/dashboard/categorias) e o do ano deixam a
//      fatura legada FORA dos totais E da quebra por categoria — a soma das
//      categorias segue batendo com o total de gastos.
//   3. ⚠️ É SÓ CONSUMO: não é adicionado ao `ehPagamentoFatura` (que governa
//      saldo/fatura). Este eval prova que o helper é separado e que uma compra
//      de crédito legítima (Supermercado etc.) continua contando.
//   4. Tudo que não é a fatura legada soma exatamente como antes.
//
// Rodar:  npm run eval:pagamento-fatura-legado
// =============================================================================
const path = require('path');
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
    categorizar: require(path.join(raiz, 'services/categorizar.js')),
  };
}

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const cent = (n) => Math.round(n * 100) / 100;

const G = 'g1';
const LINHAS = [
  // Pagamento da fatura — a linha que NÃO pode contar como consumo (conta débito).
  { grupo_id: G, data: '2026-10-16', tipo: 'Gasto', valor: 2494.83, categoria: 'Cartão de Credito', carteira_nome: 'BTG Banking', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-09-18', tipo: 'Gasto', valor: 4609.92, categoria: 'Cartão de Credito', carteira_nome: 'BTG Banking', criado_por: 'u1', transferencia: false },
  // Compras REAIS de crédito — essas SÃO consumo e têm de continuar contando.
  { grupo_id: G, data: '2026-10-02', tipo: 'Gasto', valor: 234.18, categoria: 'Supermercado', carteira_nome: 'Banco Inter Crédito', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-10-05', tipo: 'Gasto', valor: 150.00, categoria: 'Combustível', carteira_nome: 'Banco Inter Crédito', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-10-07', tipo: 'Gasto', valor: 96.60, categoria: 'Farmácia', carteira_nome: 'Banco Inter Crédito', criado_por: 'u1', transferencia: false },
  // Gasto no débito + receita real + fatura canônica (já excluída) + transferência.
  { grupo_id: G, data: '2026-10-09', tipo: 'Gasto', valor: 19.28, categoria: 'Farmácia', carteira_nome: 'BTG Banking', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-10-10', tipo: 'Recebimento', valor: 5840, categoria: '🛠️ Venda de serviços', carteira_nome: 'Inter PJ', criado_por: 'u1', transferencia: false },
  { grupo_id: G, data: '2026-10-13', tipo: 'Gasto', valor: 900, categoria: 'Fatura', carteira_nome: 'BTG Banking', criado_por: 'u1', transferencia: true },
  { grupo_id: G, data: '2026-10-12', tipo: 'Gasto', valor: 430, categoria: 'Transferências', carteira_nome: 'Inter PJ', criado_por: 'u1', transferencia: false },
];

(async () => {
  console.log('── 1. o que é (e o que NÃO é) a fatura legada ──');
  {
    const { ehPagamentoFaturaLegado, ehPagamentoFatura } = carregar([]).categorizar;
    for (const s of ['Cartão de Credito', 'Cartão de Crédito', 'cartao de credito', 'CARTÃO DE CREDITO', '  Cartão de Credito  ']) {
      eq(ehPagamentoFaturaLegado(s), true, `"${s}" é fatura legada`);
    }
    for (const s of ['Cartão', 'Crédito', 'Cartão de débito', 'Cartão de Crédito BTG', 'Fatura', 'Supermercado', 'Combustível', '', null, undefined, 'Transferências']) {
      eq(ehPagamentoFaturaLegado(s), false, `"${s}" NÃO é fatura legada`);
    }
    // ⚠️ É SEPARADO do ehPagamentoFatura (que mexe em saldo/fatura): ele NÃO pode
    // reconhecer "Cartão de Credito", senão um edit futuro pararia de debitar a conta.
    eq(ehPagamentoFatura('Cartão de Credito'), false, '⚠️ ehPagamentoFatura NÃO reconhece a categoria legada (escopo de saldo intocado)');
    eq(ehPagamentoFatura('Fatura'), true, 'ehPagamentoFatura segue reconhecendo "Fatura"');
  }
  console.log('  ok');

  console.log('── 2. resumo do mês: fatura legada fora, consumo real dentro ──');
  {
    const { resumo } = carregar(LINHAS);
    const r = await resumo.calcularResumo({ grupoId: G, mes: '2026-10' });
    // gastos de consumo = 234,18 + 150 + 96,60 + 19,28 (sem 2.494,83 da fatura legada, sem a 'Fatura' canônica, sem 'Transferências')
    eq(cent(r.gastos), cent(234.18 + 150 + 96.60 + 19.28), '⚠️ gastos sem a fatura legada (2.494,83) nem a canônica nem transferência');
    eq(cent(r.receitas), 5840, 'receitas intactas');
    eq(r.por_categoria.some((c) => /cart[aã]o de cr/i.test(c.categoria)), false, '"Cartão de Credito" some da quebra por categoria');
    eq(cent(r.por_categoria.find((c) => c.categoria === 'Supermercado')?.total), 234.18, 'Supermercado (crédito) continua contando');
    eq(cent(r.por_categoria.find((c) => c.categoria === 'Combustível')?.total), 150, 'Combustível (crédito) continua contando');
    eq(cent(r.por_categoria.find((c) => c.categoria === 'Farmácia')?.total), cent(96.60 + 19.28), 'Farmácia soma crédito + débito');
    const somaCat = cent(r.por_categoria.reduce((s, c) => s + c.total, 0));
    eq(somaCat, cent(r.gastos), '⚠️ soma das categorias = total de gastos (card × relatório)');
    eq(resumo.ehTransferencia({ categoria: 'Cartão de Credito', transferencia: false }), true, 'ehTransferencia (fonte única) reconhece a fatura legada');
    eq(resumo.ehTransferencia({ categoria: 'Supermercado', transferencia: false }), false, 'e não a compra de crédito');
  }
  console.log('  ok');

  console.log('── 3. resumo do ano espelha o do mês ──');
  {
    const { resumo } = carregar(LINHAS);
    const a = await resumo.calcularResumoAnual({ grupoId: G, ano: 2026 });
    eq(cent(a.meses[9].gastos), cent(234.18 + 150 + 96.60 + 19.28), 'outubro: gastos iguais ao resumo do mês (sem fatura legada)');
    eq(cent(a.meses[8].gastos), 0, 'setembro: só tinha a fatura legada (4.609,92) → zero de consumo');
    eq(cent(a.meses[9].receitas), 5840, 'outubro: receitas intactas');
  }
  console.log('  ok');

  console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
  if (falhas.length) { falhas.forEach((f) => console.log('  · ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
