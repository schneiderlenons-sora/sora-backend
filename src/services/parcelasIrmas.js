// =============================================================================
// EDITAR UMA PARCELA → AS OUTRAS PARCELAS DA MESMA COMPRA ACOMPANHAM.
//
// Relato (Bruno, nov/2026): renomeou a 1ª parcela de "Mlp*Kabum-Fast Shop 1/10"
// pra "Boombox 4", trocou a categoria, marcou "Valer para todas de…" — e as
// outras 9 parcelas seguiram com o nome e a categoria do banco.
//
// Duas causas somadas:
//   1. O "Valer para todas" é regra de ESTABELECIMENTO (casa por descrição), e
//      a rota gravava a regra com o nome NOVO ("boombox"), que nenhuma outra
//      linha tem. A regra nascia sem alcançar nada. (Corrigido na rota: a regra
//      usa a descrição de ANTES da edição.)
//   2. Mesmo com o nome certo, regra de estabelecimento só leva a CATEGORIA — e
//      a TODAS as compras daquela loja. O que a pessoa queria era outra coisa:
//      "esta compra é um Boombox", nas 10 parcelas. Isso é este módulo.
//
// A COMPRA é o `parcela_grupo` (o mesmo que a exclusão "todas as parcelas" já
// usa). ⚠️ Filtrado também pela CARTEIRA e pelo TOTAL de parcelas da linha
// editada: o grupo do Open Finance é um hash de (loja, total, valor, dia), e
// medido na base há 10 grupos espalhados em mais de uma carteira — escopar à
// carteira impede que um cartão alheio herde o nome.
//
// Só NOME e CATEGORIA andam. Valor, data, conta e "pago" são de cada parcela.
// Nenhum dos dois mexe em saldo, então não há reconciliação a fazer.
// =============================================================================

// "Loja 2/10", "Loja (2/10)", "Loja 02 / 10" — o marcador no FIM da descrição.
const RE_MARCADOR = /\s*\(?\s*(\d{1,3})\s*\/\s*(\d{1,3})\s*\)?\s*$/;

/** A descrição sem o "N/M" do fim (pra mostrar o nome da loja). */
function semMarcador(descricao) {
  const s = String(descricao || '');
  const limpo = s.replace(RE_MARCADOR, '').trim();
  return limpo || s.trim();
}

/**
 * O nome que a parcela IRMÃ deve receber.
 *
 * Se o nome da parcela editada termina com o marcador DELA ("Kabum 1/10"), a
 * irmã recebe o mesmo nome com o marcador DELA ("Kabum 3/10") — senão as 10
 * parcelas sairiam todas dizendo "1/10". Nome sem marcador ("Boombox 4") vai
 * igual pra todas: a parcela aparece na coluna própria da lista.
 * ⚠️ "Boombox 4" NÃO é marcador (não tem barra) — e "PNEU 205/55" também não,
 * porque o marcador só é trocado quando bate com o nº/total da parcela editada.
 */
function descricaoParaIrma(nome, editada, irma) {
  const s = String(nome || '').trim();
  const m = s.match(RE_MARCADOR);
  if (!m || !irma || irma.parcela_num == null) return s;
  const n = Number(m[1]), t = Number(m[2]);
  if (n !== Number(editada?.parcela_num) || t !== Number(editada?.parcela_total)) return s;
  const comParenteses = /\(\s*\d+\s*\/\s*\d+\s*\)\s*$/.test(s);
  const base = s.slice(0, m.index).trimEnd();
  const marca = `${irma.parcela_num}/${t}`;
  return `${base} ${comParenteses ? `(${marca})` : marca}`.trim();
}

/** A linha é parcela de uma compra com mais parcelas? */
function ehParcelaComIrmas(tx) {
  return !!(tx && tx.parcela_grupo && Number(tx.parcela_total) > 1);
}

/**
 * O que cada irmã precisa mudar pra ficar igual à parcela editada.
 * Devolve só as que de fato mudam (sem update à toa).
 * @returns {Array<{ id:string, patch:{ categoria?:string, observacao?:string } }>}
 */
function planoDasIrmas(depois, irmas) {
  const plano = [];
  for (const irma of irmas || []) {
    if (!irma || irma.id === depois.id) continue;
    const patch = {};
    if (depois.categoria && irma.categoria !== depois.categoria) patch.categoria = depois.categoria;
    const nome = descricaoParaIrma(depois.observacao, depois, irma);
    if (nome && nome !== String(irma.observacao || '').trim()) patch.observacao = nome;
    if (Object.keys(patch).length) plano.push({ id: irma.id, patch });
  }
  return plano;
}

/**
 * Leva o nome e a categoria da parcela editada às outras parcelas da compra.
 *
 * @param {object} p
 * @param {string} p.grupoId
 * @param {object} p.antes   a linha ANTES da edição (é ela que diz a compra e a carteira)
 * @param {object} p.depois  a linha DEPOIS da edição
 * @returns {Promise<{ atualizadas:number, irmas:number }>}
 */
async function aplicarNasParcelas({ grupoId, antes, depois }, { supabase = require('../db/supabase') } = {}) {
  if (!grupoId || !ehParcelaComIrmas(antes) || !depois) return { atualizadas: 0, irmas: 0 };
  let q = supabase.from('transacoes')
    .select('id, observacao, categoria, parcela_num, parcela_total')
    .eq('grupo_id', grupoId)
    .eq('parcela_grupo', antes.parcela_grupo)
    .eq('parcela_total', antes.parcela_total)
    .neq('id', depois.id);
  if (antes.carteira_nome) q = q.eq('carteira_nome', antes.carteira_nome);
  const { data: irmas, error } = await q;
  // Leitura que falhou não escreve nada (não se adivinha quais são as irmãs).
  if (error || !irmas) return { atualizadas: 0, irmas: 0 };

  const plano = planoDasIrmas(depois, irmas);
  let atualizadas = 0;
  // Mesma mudança em várias linhas (o caso comum: só a categoria, ou nome sem
  // marcador) vai num update só — o custo do Supabase é o NÚMERO de idas.
  const porPatch = new Map();
  for (const { id, patch } of plano) {
    const k = JSON.stringify(patch);
    (porPatch.get(k) || porPatch.set(k, { patch, ids: [] }).get(k)).ids.push(id);
  }
  for (const { patch, ids } of porPatch.values()) {
    const { error: e } = await supabase.from('transacoes').update(patch)
      .in('id', ids).eq('grupo_id', grupoId);
    if (!e) atualizadas += ids.length;
  }
  return { atualizadas, irmas: irmas.length };
}

module.exports = { semMarcador, descricaoParaIrma, ehParcelaComIrmas, planoDasIrmas, aplicarNasParcelas, RE_MARCADOR };
