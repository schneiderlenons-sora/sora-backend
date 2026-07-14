// =====================================================================
// Detecta possíveis gastos/receitas fixas a partir das transações (Open
// Finance, OFX, manuais). Heurística: mesmo estabelecimento + valor estável
// repetindo em vários meses = candidato a recorrência. Não cria nada — só
// sugere; o usuário aprova com 1 clique (vira uma `recorrencia`).
// =====================================================================
const supabase = require('../db/supabase');

// Chave de agrupamento: descrição sem números/pontuação (assinatura tende a
// ter descrição estável mês a mês — "SPOTIFY", "NETFLIX.COM").
const chaveDe = (s) => (s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\d+/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Parcela ("12/12", "3/10") — não é recorrência, é compra parcelada.
const ehParcela = (s) => /\b\d{1,2}\s*\/\s*\d{1,2}\b/.test(s || '');

function maisComum(arr) {
  const c = new Map();
  for (const x of arr) c.set(x, (c.get(x) || 0) + 1);
  let melhor = null, n = -1;
  for (const [k, v] of c) if (v > n) { melhor = k; n = v; }
  return melhor;
}

async function detectarRecorrencias(grupoId) {
  if (!grupoId) return [];

  const desde = new Date(); desde.setMonth(desde.getMonth() - 6);
  // Inclui parcela_grupo pra EXCLUIR compras parceladas (repetem mês a mês, mas
  // têm fim — não são fixo). Tolerante à migration 071 ainda não rodada.
  let { data: txs, error: eTx } = await supabase.from('transacoes')
    .select('tipo, categoria, valor, observacao, data, transferencia, parcela_grupo')
    .eq('grupo_id', grupoId)
    .gte('data', desde.toISOString());
  if (eTx) {
    ({ data: txs } = await supabase.from('transacoes')
      .select('tipo, categoria, valor, observacao, data, transferencia')
      .eq('grupo_id', grupoId)
      .gte('data', desde.toISOString()));
  }

  // Recorrências já cadastradas — não sugere o que já existe.
  const { data: jaTem } = await supabase.from('recorrencias')
    .select('descricao').eq('grupo_id', grupoId).eq('ativa', true);
  const existentes = new Set((jaTem || []).map(r => chaveDe(r.descricao)));

  // Sugestões que o usuário JÁ dispensou — não trazer de volta.
  try {
    const { data: disp } = await supabase.from('recorrencias_dispensadas')
      .select('chave').eq('grupo_id', grupoId);
    for (const d of disp || []) existentes.add(d.chave);
  } catch { /* migration 058 pode não ter rodado ainda */ }

  const grupos = new Map();
  for (const t of txs || []) {
    if (t.transferencia || t.categoria === 'Fatura cartão' || t.categoria === 'Transferências') continue;
    if (t.parcela_grupo) continue; // compra parcelada não é fixo/recorrência
    const desc = (t.observacao || t.categoria || '').trim();
    if (ehParcela(desc)) continue;
    const chave = chaveDe(desc) || chaveDe(t.categoria);
    if (!chave || chave.length < 3) continue;
    const d = new Date(t.data);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push({
      valor: Number(t.valor) || 0, dia: d.getUTCDate(),
      mes: String(t.data).slice(0, 7), tipo: t.tipo, categoria: t.categoria, label: desc,
    });
  }

  const sugestoes = [];
  for (const [chave, itens] of grupos) {
    if (existentes.has(chave)) continue;
    const meses = new Set(itens.map(i => i.mes));
    // Critério rígido (evita falso positivo): tem que cair em >=3 meses
    // DIFERENTES e ter >=3 ocorrências — cadência mensal de verdade.
    if (meses.size < 3 || itens.length < 3) continue;

    // Valor MUITO estável = assinatura (gasto variável tipo mercado/iFood sai).
    const valores = itens.map(i => i.valor).sort((a, b) => a - b);
    const mediana = valores[Math.floor(valores.length / 2)];
    if (mediana <= 0) continue;
    const desvioMax = Math.max(...valores.map(v => Math.abs(v - mediana)));
    if (desvioMax > Math.max(2, mediana * 0.08)) continue; // varia >8% → não é fixo

    const dias = itens.map(i => i.dia).sort((a, b) => a - b);
    const dia = Math.min(28, Math.max(1, dias[Math.floor(dias.length / 2)]));

    sugestoes.push({
      descricao: maisComum(itens.map(i => i.label)) || chave,
      valor: Math.round(mediana * 100) / 100,
      dia,
      tipo: maisComum(itens.map(i => i.tipo)) || 'Gasto',
      categoria: maisComum(itens.map(i => i.categoria)) || 'Outros',
      ocorrencias: itens.length,
      meses: meses.size,
    });
  }

  // Mais "garantidos" primeiro (mais meses), depois maior valor.
  sugestoes.sort((a, b) => b.meses - a.meses || b.valor - a.valor);
  return sugestoes.slice(0, 20);
}

module.exports = { detectarRecorrencias, chaveDe };
