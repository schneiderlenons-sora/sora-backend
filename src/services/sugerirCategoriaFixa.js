// =====================================================================
// Sugere a categoria certa pras contas fixas que ficaram em "Outros".
//
// POR QUE EXISTE: medido na base, 61 de 190 recorrências ativas estão em
// "Outros" — quase um terço. Não é bug: a categoria é opcional na criação e o
// auto-categorizador não cobre tudo (categorizarDescricao('luz') devolve null).
// Só que "Outros" com um terço do dinheiro dentro torna o relatório inútil.
//
// A ideia: o usuário JÁ categorizou as transações reais daquele mesmo
// estabelecimento. Se "NETFLIX.COM" caiu 6× em Assinaturas, a conta fixa
// "Netflix" é Assinaturas. A Sora não adivinha — ela lê o que o usuário fez.
//
// ⚠️ SUGERE, não aplica. Categoria mexe em relatório, limite e Wrapped;
// trocar sozinho o que o usuário deixou em "Outros" é decidir por ele.
// =====================================================================
// DUAS FONTES, medidas nas 61 recorrências em "Outros" da base:
//
//   transacoes (forte) → o usuário JÁ categorizou aquele estabelecimento.
//                        Resolve ~8. Poucas porque 28 dos 61 casos são
//                        CIRCULARES: a única transação que casa é a que a
//                        própria Sora criou a partir da recorrência, e ela
//                        herdou "Outros" dela. Não há evidência independente.
//   descricao (fraca)  → o categorizador local lê o nome. Resolve 23, mas
//                        erra às vezes ("Assinatura Sora Premium" → Autocuidado).
//
// Por isso a evidência de transações vem SEMPRE na frente, e a fonte viaja
// junto com a sugestão pra tela poder dizer em que ela se baseou. O usuário
// aceita com 1 clique — ele merece saber se é "vi você fazer isso 5 vezes" ou
// "chutei pelo nome".
const supabase = require('../db/supabase');
const { chaveDe } = require('./detectarRecorrencias');
const { ehPagamentoFatura, categorizarDescricao } = require('./categorizar');

const GENERICAS = new Set(['Outros', 'Outro', 'Transferências', 'Sem categoria', '']);

/** Casa a descrição da conta fixa com a da transação. */
function casa(chaveFixa, chaveTx) {
  if (!chaveFixa || !chaveTx) return false;
  if (chaveFixa === chaveTx) return true;
  // Contenção nos dois sentidos: o usuário digita "Netflix", o banco manda
  // "netflix com br". Mínimo de 4 letras pra "luz" não casar com "cruzeiro".
  if (chaveFixa.length >= 4 && chaveTx.includes(chaveFixa)) return true;
  if (chaveTx.length >= 4 && chaveFixa.includes(chaveTx)) return true;
  return false;
}

/**
 * Escolhe a categoria dominante entre as transações que casaram.
 * Devolve `null` quando não há sinal claro — é melhor não sugerir nada do que
 * sugerir errado, porque uma sugestão errada aceita com 1 clique estraga o
 * relatório e o usuário não descobre.
 */
function dominante(categorias) {
  const cont = new Map();
  for (const c of categorias) cont.set(c, (cont.get(c) || 0) + 1);
  if (!cont.size) return null;
  const ordenado = [...cont].sort((a, b) => b[1] - a[1]);
  const [melhor, n] = ordenado[0];
  const total = categorias.length;
  // Precisa aparecer 2× e ser MAIORIA. Uma ocorrência solta pode ser um
  // lançamento avulso; empate significa que nem o usuário decidiu ainda.
  if (n < 2 || n / total <= 0.5) return null;
  return { categoria: melhor, ocorrencias: n, total };
}

/**
 * Sugestões de categoria pras contas fixas genéricas do grupo.
 * Uma consulta de transações pro grupo inteiro (não uma por recorrência).
 */
async function sugerirCategorias(grupoId) {
  if (!grupoId) return [];

  const { data: recs } = await supabase.from('recorrencias')
    .select('id, tipo, categoria, descricao')
    .eq('grupo_id', grupoId).eq('ativa', true);

  const alvos = (recs || []).filter((r) => GENERICAS.has(String(r.categoria || '').trim()));
  if (!alvos.length) return [];

  const desde = new Date(); desde.setMonth(desde.getMonth() - 6);
  const { data: txs } = await supabase.from('transacoes')
    .select('tipo, categoria, observacao, transferencia')
    .eq('grupo_id', grupoId).gte('data', desde.toISOString());

  // Só transações JÁ categorizadas de verdade servem de evidência.
  const uteis = (txs || []).filter((t) =>
    !t.transferencia
    && !ehPagamentoFatura(t.categoria)
    && !GENERICAS.has(String(t.categoria || '').trim())
    && (t.observacao || '').trim());

  // A categoria sugerida tem de EXISTIR no catálogo do grupo — mesma lição do
  // '💼 Salário' fantasma: sugerir um nome morto recriaria o bug.
  const { data: cats } = await supabase.from('categorias').select('nome').eq('grupo_id', grupoId);
  const existe = new Set((cats || []).map((c) => c.nome));

  const indexadas = uteis.map((t) => ({ chave: chaveDe(t.observacao), tipo: t.tipo, categoria: t.categoria }));

  const out = [];
  for (const r of alvos) {
    const chaveFixa = chaveDe(r.descricao);
    if (!chaveFixa || chaveFixa.length < 3) continue;

    // 1º) evidência real: o que o usuário fez com esse mesmo estabelecimento.
    const casadas = indexadas
      .filter((t) => t.tipo === r.tipo && casa(chaveFixa, t.chave))
      .map((t) => t.categoria);
    const d = dominante(casadas);
    if (d && existe.has(d.categoria) && d.categoria !== r.categoria) {
      out.push({
        id: r.id, descricao: r.descricao, atual: r.categoria || 'Outros',
        sugerida: d.categoria, fonte: 'transacoes',
        motivo: `você categorizou assim ${d.ocorrencias} de ${d.total} vez${d.total > 1 ? 'es' : ''}`,
        ocorrencias: d.ocorrencias, analisadas: d.total,
      });
      continue;
    }

    // 2º) só o nome. Mais fraco e assumido como tal na mensagem.
    const pelaDescricao = categorizarDescricao(r.descricao);
    if (pelaDescricao && existe.has(pelaDescricao) && pelaDescricao !== r.categoria) {
      out.push({
        id: r.id, descricao: r.descricao, atual: r.categoria || 'Outros',
        sugerida: pelaDescricao, fonte: 'descricao',
        motivo: 'pelo nome da conta',
        ocorrencias: 0, analisadas: 0,
      });
    }
  }
  return out;
}

module.exports = { sugerirCategorias, casa, dominante, GENERICAS };
