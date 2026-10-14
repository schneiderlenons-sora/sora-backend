// =============================================================================
// EVAL — reconciliação de reprocesso do agregador.
//
// Garante que apaga a cópia VELHA do reprocesso e NUNCA uma compra legítima.
// Rodar: npm run eval:dedup-reprocesso
// =============================================================================
const { planejarDedupReprocesso, assinaturaTx } = require('../src/services/dedupReprocesso');

const falhas = [];
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const setIds = (...ids) => new Set(ids);
const linha = (o) => ({ id: o.id, of_tx_id: o.of, data: o.data, valor: o.valor, observacao: o.obs, categoria: o.cat ?? 'Outros', parcela_num: o.pn ?? null, parcela_total: o.pt ?? null });

// ── 1. REPROCESSO clássico: 1 velha (fora) + 1 nova (dentro), mesma assinatura ──
{
  const db = [
    linha({ id: 'velha', of: 'ID_ANTIGO', data: '2026-10-03', valor: 76.35, obs: 'PERFUMARIA CHEIRINHO' }),
    linha({ id: 'nova',  of: 'ID_NOVO',   data: '2026-10-03', valor: 76.35, obs: 'PERFUMARIA CHEIRINHO' }),
  ];
  const r = planejarDedupReprocesso({ dbRows: db, batchIds: setIds('ID_NOVO') });
  eq(r.aDeletar, ['velha'], '1 apaga a cópia velha (id fora do batch)');
}

// ── 2. duas compras iguais em DIAS DIFERENTES: assinaturas distintas, intocadas ──
{
  const db = [
    linha({ id: 'a', of: 'A', data: '2026-08-06', valor: 130, obs: 'BAR DO ZE' }),
    linha({ id: 'b', of: 'B', data: '2026-08-24', valor: 130, obs: 'BAR DO ZE' }),
    linha({ id: 'c', of: 'C', data: '2026-08-31', valor: 130, obs: 'BAR DO ZE' }),
  ];
  const r = planejarDedupReprocesso({ dbRows: db, batchIds: setIds('A', 'B', 'C') });
  eq(r.aDeletar, [], '2 compras iguais em dias diferentes NÃO são apagadas');
}

// ── 3. duas compras iguais no MESMO dia, sync NORMAL (ambos ids no batch) ──
{
  const db = [
    linha({ id: 'a', of: 'A', data: '2026-08-10', valor: 15, obs: 'CAFE' }),
    linha({ id: 'b', of: 'B', data: '2026-08-10', valor: 15, obs: 'CAFE' }),
  ];
  const r = planejarDedupReprocesso({ dbRows: db, batchIds: setIds('A', 'B') });
  eq(r.aDeletar, [], '3 dois cafés iguais no mesmo dia, ambos reportados → nada apaga');
}

// ── 4. MESMO dia, REPROCESSO: 2 velhas + 2 novas → apaga as 2 velhas, sobra 2 ──
{
  const db = [
    linha({ id: 'v1', of: 'A', data: '2026-08-10', valor: 15, obs: 'CAFE' }),
    linha({ id: 'v2', of: 'B', data: '2026-08-10', valor: 15, obs: 'CAFE' }),
    linha({ id: 'n1', of: 'C', data: '2026-08-10', valor: 15, obs: 'CAFE' }),
    linha({ id: 'n2', of: 'D', data: '2026-08-10', valor: 15, obs: 'CAFE' }),
  ];
  const r = planejarDedupReprocesso({ dbRows: db, batchIds: setIds('C', 'D') });
  eq(r.aDeletar.sort(), ['v1', 'v2'], '4 reprocesso de par idêntico: apaga as 2 velhas, mantém as 2 novas (contagem preservada)');
}

// ── 5. fora SEM gêmea no batch: NÃO apaga (pode ser legítima/fora da janela) ──
{
  const db = [
    linha({ id: 'x', of: 'X', data: '2026-07-01', valor: 50, obs: 'POSTO' }),
    linha({ id: 'y', of: 'Y', data: '2026-10-01', valor: 99, obs: 'MERCADO' }),
  ];
  const r = planejarDedupReprocesso({ dbRows: db, batchIds: setIds('Y') });
  eq(r.aDeletar, [], '5 linha fora do batch sem gêmea dentro → intocada');
}

// ── 6. linha MANUAL (sem of_tx_id) nunca entra ──
{
  const db = [
    { id: 'man', of_tx_id: null, data: '2026-10-03', valor: 76.35, observacao: 'PERFUMARIA CHEIRINHO', categoria: 'Outros', parcela_num: null, parcela_total: null },
    linha({ id: 'nova', of: 'ID_NOVO', data: '2026-10-03', valor: 76.35, obs: 'PERFUMARIA CHEIRINHO' }),
  ];
  const r = planejarDedupReprocesso({ dbRows: db, batchIds: setIds('ID_NOVO') });
  eq(r.aDeletar, [], '6 manual não é cópia velha (sem of_tx_id) — não apaga');
}

// ── 7. CATEGORIA corrigida à mão na velha → leva pro sobrevivente ──
{
  const db = [
    linha({ id: 'velha', of: 'A', data: '2026-10-03', valor: 76.35, obs: 'FernandoPeixoto', cat: 'Autocuidado' }),
    linha({ id: 'nova',  of: 'B', data: '2026-10-03', valor: 76.35, obs: 'FernandoPeixoto', cat: 'Outros' }),
  ];
  const r = planejarDedupReprocesso({ dbRows: db, batchIds: setIds('B') });
  eq(r.aDeletar, ['velha'], '7 apaga a velha');
  eq(r.reclassificar, [{ id: 'nova', categoria: 'Autocuidado' }], '7 carrega a categoria corrigida pro sobrevivente');
}

// ── 7B. se o sobrevivente JÁ tem categoria específica, NÃO sobrescreve ──
{
  const db = [
    linha({ id: 'velha', of: 'A', data: '2026-10-03', valor: 76.35, obs: 'X', cat: 'Lazer' }),
    linha({ id: 'nova',  of: 'B', data: '2026-10-03', valor: 76.35, obs: 'X', cat: 'Farmácia' }),
  ];
  const r = planejarDedupReprocesso({ dbRows: db, batchIds: setIds('B') });
  eq(r.reclassificar, [], '7B sobrevivente com categoria própria não é sobrescrito');
}

// ── 8. contagem N: 3 novas (dentro) + 2 velhas (fora) → apaga as 2 velhas ──
{
  const db = [
    linha({ id: 'v1', of: 'A', data: '2026-09-01', valor: 20, obs: 'IFOOD' }),
    linha({ id: 'v2', of: 'B', data: '2026-09-01', valor: 20, obs: 'IFOOD' }),
    linha({ id: 'n1', of: 'C', data: '2026-09-01', valor: 20, obs: 'IFOOD' }),
    linha({ id: 'n2', of: 'D', data: '2026-09-01', valor: 20, obs: 'IFOOD' }),
    linha({ id: 'n3', of: 'E', data: '2026-09-01', valor: 20, obs: 'IFOOD' }),
  ];
  const r = planejarDedupReprocesso({ dbRows: db, batchIds: setIds('C', 'D', 'E') });
  eq(r.aDeletar.sort(), ['v1', 'v2'], '8 mantém as 3 do batch, apaga as 2 velhas');
}

// ── 9. batch VAZIO (sync flaky / erro) → NÃO apaga nada ──
{
  const db = [
    linha({ id: 'a', of: 'A', data: '2026-10-03', valor: 76.35, obs: 'X' }),
    linha({ id: 'b', of: 'B', data: '2026-10-03', valor: 76.35, obs: 'X' }),
  ];
  const r = planejarDedupReprocesso({ dbRows: db, batchIds: setIds() });
  eq(r.aDeletar, [], '9 batch vazio → nada apaga (precisa de gêmea dentro)');
}

// ── 10. assinatura: parcela distingue, descrição normaliza acento/caixa ──
{
  eq(assinaturaTx({ data: '2026-10-03T00:00:00+00:00', valor: 10, observacao: 'Padaria', parcela_num: 1, parcela_total: 3 }),
     assinaturaTx({ data: '2026-10-03', valor: 10, observacao: 'PADARIA', parcela_num: 1, parcela_total: 3 }),
     '10 mesma assinatura (dia + acento/caixa normalizados)');
  const dif = assinaturaTx({ data: '2026-10-03', valor: 10, observacao: 'Padaria', parcela_num: 1, parcela_total: 3 })
          !== assinaturaTx({ data: '2026-10-03', valor: 10, observacao: 'Padaria', parcela_num: 2, parcela_total: 3 });
  eq(dif, true, '10 parcela 1/3 ≠ 2/3 (não funde parcelas diferentes)');
}

console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) { falhas.forEach((f) => console.log('  · ' + f)); process.exit(1); }
