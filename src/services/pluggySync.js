// =====================================================================
// Sincroniza um item do Pluggy com a Sora:
//   conta Pluggy   → wallet (saldo = saldo real do Pluggy, fonte da verdade)
//   transação Pluggy → transacao (dedup por pluggy_tx_id)
// Tolerante: erro numa conta/transação não derruba o resto; marca status.
// =====================================================================
const supabase = require('../db/supabase');
const pluggy   = require('./pluggy');

const idCurto = () => Math.random().toString(36).substring(2, 8).toUpperCase();
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

// Conta Pluggy → carteira da Sora. Reusa a carteira já mapeada; senão adota uma
// manual de mesmo nome; senão cria. Atualiza o saldo com o valor real do Pluggy.
async function upsertWallet(grupoId, userId, account) {
  const tipo = account.type === 'CREDIT' ? 'Crédito'
             : account.subtype === 'SAVINGS_ACCOUNT' ? 'Poupança' : 'Corrente';
  const nome = (account.name || account.marketingName || 'Conta').toString().trim().slice(0, 60);
  const saldo = Number(account.balance || 0);

  // 1) já mapeada a esta conta Pluggy?
  const { data: jaMapeada } = await supabase.from('wallets')
    .select('id, nome').eq('grupo_id', grupoId).eq('pluggy_account_id', account.id).maybeSingle();
  if (jaMapeada) {
    await supabase.from('wallets').update({ saldo, tipo }).eq('id', jaMapeada.id);
    return jaMapeada.nome;
  }
  // 2) adota uma carteira manual de mesmo nome (ainda sem Pluggy)
  const { data: mesmoNome } = await supabase.from('wallets')
    .select('id, nome').eq('grupo_id', grupoId).ilike('nome', nome).maybeSingle();
  if (mesmoNome) {
    await supabase.from('wallets').update({ saldo, tipo, pluggy_account_id: account.id }).eq('id', mesmoNome.id);
    return mesmoNome.nome;
  }
  // 3) cria nova
  const row = { grupo_id: grupoId, nome, tipo, saldo, pluggy_account_id: account.id };
  if (userId) row.criado_por = userId;
  let { data: nova, error } = await supabase.from('wallets').insert(row).select('nome').single();
  if (error) { // colisão de nome (unique grupo_id,nome) → desambígua
    ({ data: nova } = await supabase.from('wallets')
      .insert({ ...row, nome: `${nome} (Pluggy)`.slice(0, 60) }).select('nome').single());
  }
  return nova?.nome || nome;
}

// Mapeia uma transação Pluggy pro formato da Sora.
function mapTx(tx, grupoId, userId, walletNome) {
  const amount = Number(tx.amount || 0);
  const ehGasto = amount < 0; // Pluggy: negativo = saída, positivo = entrada
  return {
    id_curto:      idCurto(),
    grupo_id:      grupoId,
    criado_por:    userId || null,
    tipo:          ehGasto ? 'Gasto' : 'Recebimento',
    categoria:     'Outros', // TODO: mapear tx.category → categorias da Sora
    valor:         Math.abs(amount),
    observacao:    (tx.description || tx.descriptionRaw || '').toString().slice(0, 200),
    carteira_nome: walletNome,
    pago:          true,
    data:          tx.date || new Date().toISOString(),
    pluggy_tx_id:  tx.id,
  };
}

// Insere só as transações ainda não importadas (dedup por pluggy_tx_id).
async function inserirNovas(grupoId, userId, walletNome, txs) {
  if (!txs.length) return 0;
  const ids = txs.map(t => t.id).filter(Boolean);
  const existentes = new Set();
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await supabase.from('transacoes')
      .select('pluggy_tx_id').in('pluggy_tx_id', ids.slice(i, i + 300));
    (data || []).forEach(d => existentes.add(d.pluggy_tx_id));
  }
  const novas = txs.filter(t => t.id && !existentes.has(t.id))
                   .map(t => mapTx(t, grupoId, userId, walletNome));
  if (!novas.length) return 0;
  const { error } = await supabase.from('transacoes').insert(novas);
  if (error) { // fallback: uma a uma (a única em pluggy_tx_id ignora corridas)
    let n = 0;
    for (const row of novas) {
      const { error: e } = await supabase.from('transacoes').insert(row);
      if (!e) n++;
    }
    return n;
  }
  return novas.length;
}

// Sincroniza um item inteiro (todas as contas + transações).
async function sincronizarItem(itemId) {
  const { data: item } = await supabase.from('pluggy_items').select('*').eq('item_id', itemId).maybeSingle();
  if (!item) { console.warn('[pluggy] webhook de item desconhecido:', itemId); return; }

  try {
    const info = await pluggy.getItem(itemId);
    const connectorNome = info?.connector?.name || item.connector_nome || null;

    const contas = await pluggy.listarContas(itemId);
    const from = item.ultima_sync
      ? ymd(new Date(item.ultima_sync).getTime() - 3 * 864e5)  // overlap 3 dias
      : ymd(Date.now() - 90 * 864e5);                          // 1ª vez: 90 dias

    let total = 0;
    for (const acc of contas) {
      try {
        const walletNome = await upsertWallet(item.grupo_id, item.user_id, acc);
        const txs = await pluggy.listarTransacoes(acc.id, from);
        total += await inserirNovas(item.grupo_id, item.user_id, walletNome, txs);
      } catch (e) {
        console.warn(`[pluggy] conta ${acc.id} falhou:`, e.message);
      }
    }

    await supabase.from('pluggy_items').update({
      status: 'updated', connector_nome: connectorNome,
      ultima_sync: new Date().toISOString(), ultimo_erro: null,
    }).eq('item_id', itemId);
    console.log(`[pluggy] item ${itemId} sincronizado: +${total} transações`);
    return total;
  } catch (e) {
    console.warn('[pluggy] sync falhou', itemId, e.message);
    await supabase.from('pluggy_items').update({
      status: 'error', ultimo_erro: String(e.message).slice(0, 300),
    }).eq('item_id', itemId);
  }
}

async function marcarErro(itemId, erro) {
  await supabase.from('pluggy_items').update({
    status: 'error', ultimo_erro: (typeof erro === 'string' ? erro : JSON.stringify(erro || {})).slice(0, 300),
  }).eq('item_id', itemId);
}

module.exports = { sincronizarItem, marcarErro };
