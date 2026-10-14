// =============================================================================
// Reconciliação de REPROCESSO do agregador (Open Finance).
//
// ⚠️ PROBLEMA (medido 14/10/2026): o agregador (Celcoin) às vezes REPROCESSA as
// transações de um cartão/conta e as regrava com `of_tx_id` NOVO. Como o dedup
// do sync é por `of_tx_id`, as cópias antigas FICAM e a conta dobra. Medido na
// base: 1.094 linhas extras, R$ 302.953 inflados, 39 usuários, 84 cartões/contas
// (caso que originou: Mayra — 217 linhas, cartão Santander reprocessado em 06/10).
//
// ⚠️ O CRITÉRIO É DE ORIGEM, NÃO "mesma data+valor+descrição" solto. Deduplicar
// por assinatura sozinha apagaria DUAS COMPRAS IGUAIS legítimas (ver CLAUDE.md:
// "R$ 130 no mesmo bar 3x no mês"). Aqui a assinatura só serve pra PAREAR; quem
// decide é a ORIGEM: a cópia velha é a linha cujo `of_tx_id` o agregador NÃO
// manda mais (fora do batch atual) E que tem uma GÊMEA cujo id ESTÁ no batch
// (ou seja, o agregador re-enviou aquela transação com id novo = reprocesso).
//
// Garantias:
//  · Compras iguais em DIAS diferentes → assinaturas diferentes → intocadas.
//  · Compras iguais no MESMO dia → a CONTAGEM é preservada (apaga só as de fora;
//    sobram exatamente as que o agregador reporta agora).
//  · Linha SEM gêmea no batch → intocada (pode ser mais antiga que a janela, ou
//    o agregador só deixou de mandá-la — na dúvida, NÃO apaga).
//  · Linha manual (sem `of_tx_id`) → NUNCA entra (quem chama já filtra).
//  · A categoria corrigida à mão na cópia velha é LEVADA pro sobrevivente antes
//    de apagar (senão o "protege a categoria" do projeto regrediria).
//
// Função PURA — o sync faz o IO (ler as linhas da janela, apagar, reclassificar)
// e chama isto. Eval: npm run eval:dedup-reprocesso
// =============================================================================

const cent = (v) => Math.round(Number(v || 0) * 100);
const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

/** Assinatura EXATA que pareia a cópia velha com a nova (dia, não instante). */
function assinaturaTx(r) {
  return [
    String(r.data || '').slice(0, 10),
    cent(r.valor),
    norm(r.observacao),
    r.parcela_num ?? '',
    r.parcela_total ?? '',
  ].join('|');
}

const CATEGORIA_DEFAULT = new Set(['', 'outros', 'outro']);
const ehDefault = (c) => CATEGORIA_DEFAULT.has(norm(c));

/**
 * PURA. Decide o que apagar e o que reclassificar.
 *
 * @param {Object} p
 * @param {Array}  p.dbRows   linhas do cartão/conta na JANELA do batch
 *                            { id, of_tx_id, data, valor, observacao, categoria,
 *                              parcela_num, parcela_total }
 * @param {Set}    p.batchIds `of_tx_id` que o agregador mandou NESTE sync
 * @returns {{ aDeletar: Array<string|number>, reclassificar: Array<{id:any, categoria:string}> }}
 */
function planejarDedupReprocesso({ dbRows, batchIds } = {}) {
  const vazio = { aDeletar: [], reclassificar: [] };
  if (!Array.isArray(dbRows) || !(batchIds instanceof Set)) return vazio;

  const grupos = new Map();
  for (const r of dbRows) {
    if (!r || !r.of_tx_id) continue;              // nunca toca linha manual
    const k = assinaturaTx(r);
    if (!grupos.has(k)) grupos.set(k, { dentro: [], fora: [] });
    (batchIds.has(r.of_tx_id) ? grupos.get(k).dentro : grupos.get(k).fora).push(r);
  }

  const aDeletar = [];
  const reclassificar = [];
  for (const { dentro, fora } of grupos.values()) {
    // ⚠️ SÓ apaga quando há gêmea DENTRO do batch (origem = reprocesso). Sem
    // isso é compra que o agregador não re-enviou — pode ser legítima.
    if (!dentro.length || !fora.length) continue;

    // Categoria corrigida à mão na cópia velha → leva pro sobrevivente, mas só
    // quando o par é 1↔1 (sem ambiguidade) e o sobrevivente está no default.
    if (dentro.length === 1) {
      const catVelha = fora
        .map((f) => f.categoria)
        .find((c) => c && !ehDefault(c));
      if (catVelha && ehDefault(dentro[0].categoria) && norm(catVelha) !== norm(dentro[0].categoria)) {
        reclassificar.push({ id: dentro[0].id, categoria: catVelha });
      }
    }

    for (const velho of fora) aDeletar.push(velho.id);
  }

  return { aDeletar, reclassificar };
}

module.exports = { planejarDedupReprocesso, assinaturaTx };
