// =====================================================================
// copiarDadosGrupo — copia contas, categorias e transações de um grupo
// para outro (usado ao criar um grupo compartilhado "trazendo" as finanças
// atuais do usuário). O grupo de origem fica INTACTO (é cópia, não move).
//
// Best-effort por etapa: se uma falhar, as outras seguem e o grupo já existe.
// =====================================================================
const supabase = require('../db/supabase');

const idCurto = () => Math.random().toString(36).substring(2, 8).toUpperCase();
function emLotes(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function copiarDadosGrupo(origemId, destinoId, userId) {
  if (!origemId || !destinoId || origemId === destinoId) return;

  // 1) Categorias — preserva hierarquia pai/filho (remapeia parent_id).
  try {
    const { data: cats } = await supabase.from('categorias')
      .select('id, nome, icone, cor, tipo, parent_id, ativa').eq('grupo_id', origemId);
    if (cats?.length) {
      const idMap = {};
      for (const c of cats.filter(c => !c.parent_id)) {
        const { data: novo } = await supabase.from('categorias')
          .insert({ grupo_id: destinoId, nome: c.nome, icone: c.icone, cor: c.cor, tipo: c.tipo, ativa: c.ativa })
          .select('id').single();
        if (novo) idMap[c.id] = novo.id;
      }
      const filhos = cats.filter(c => c.parent_id).map(c => ({
        grupo_id: destinoId, nome: c.nome, icone: c.icone, cor: c.cor, tipo: c.tipo, ativa: c.ativa,
        parent_id: idMap[c.parent_id] || null,
      }));
      if (filhos.length) await supabase.from('categorias').insert(filhos);
    }
  } catch (e) { console.warn('[copiarGrupo] categorias:', e.message); }

  // 2) Contas/cartões — com o dono = quem criou o grupo.
  try {
    const { data: ws } = await supabase.from('wallets')
      .select('nome, tipo, saldo, limite, dia_fechamento, dia_vencimento, bandeira, ultimos4')
      .eq('grupo_id', origemId);
    if (ws?.length) {
      await supabase.from('wallets').insert(ws.map(w => ({ ...w, grupo_id: destinoId, criado_por: userId })));
    }
  } catch (e) { console.warn('[copiarGrupo] wallets:', e.message); }

  // 3) Transações — em lotes (pode ser muita coisa).
  try {
    const { data: txs } = await supabase.from('transacoes')
      .select('tipo, categoria, valor, observacao, carteira_nome, data, pago, transferencia')
      .eq('grupo_id', origemId);
    if (txs?.length) {
      for (const lote of emLotes(txs, 500)) {
        await supabase.from('transacoes').insert(lote.map(t => ({
          ...t, grupo_id: destinoId, criado_por: userId, id_curto: idCurto(),
        })));
      }
    }
  } catch (e) { console.warn('[copiarGrupo] transacoes:', e.message); }
}

module.exports = { copiarDadosGrupo };
