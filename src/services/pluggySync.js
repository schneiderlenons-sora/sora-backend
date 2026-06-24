// =====================================================================
// Sincroniza um item do Pluggy com a Sora:
//   conta Pluggy   → wallet (saldo = saldo real do Pluggy, fonte da verdade)
//   transação Pluggy → transacao (dedup por pluggy_tx_id)
// Tolerante: erro numa conta/transação não derruba o resto; marca status.
// =====================================================================
const supabase = require('../db/supabase');
const pluggy   = require('./pluggy');
const { categorizar } = require('./categorizar');

const idCurto = () => Math.random().toString(36).substring(2, 8).toUpperCase();
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

// Dia do mês de uma data ISO, clampado em 1..28 (constraint da migration 023).
// `new Date(null)` é válido (vira dia 1) — por isso o guard de falsy primeiro.
function diaClamp(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return Math.min(28, Math.max(1, d.getUTCDate()));
}

// Bandeira do Pluggy ("MASTERCARD") → conjunto aceito pela Sora (migration 023).
function mapBandeira(brand) {
  const m = { MASTERCARD: 'Mastercard', VISA: 'Visa', ELO: 'Elo', AMEX: 'Amex',
              'AMERICAN EXPRESS': 'Amex', HIPERCARD: 'Hipercard' };
  return m[(brand || '').toString().toUpperCase()] || null;
}

// Campos extras de cartão de crédito a partir de account.creditData.
function camposCredito(account) {
  const cd = account.creditData || {};
  const out = {};
  if (cd.creditLimit != null) out.limite = Number(cd.creditLimit);
  const fech = diaClamp(cd.balanceCloseDate); if (fech) out.dia_fechamento = fech;
  const venc = diaClamp(cd.balanceDueDate);  if (venc) out.dia_vencimento = venc;
  const band = mapBandeira(cd.brand);         if (band) out.bandeira = band;
  return out;
}

// Nome ÚNICO por cartão — vários cartões do mesmo banco não podem virar a mesma
// carteira. Usa banco + nível/nome do cartão + últimos 4 dígitos (quando vêm).
function nomeCartao(connectorNome, account) {
  const cd = account.creditData || {};
  const banco = (connectorNome || '').trim();
  const base = (account.name || account.marketingName || cd.level || 'Crédito').toString().trim();
  let nome = banco && !base.toLowerCase().includes(banco.toLowerCase()) ? `${banco} ${base}` : base;
  const last4 = (account.number || '').toString().replace(/\D/g, '').slice(-4);
  if (last4) nome += ` ••${last4}`;
  return nome.slice(0, 60);
}

// Conta Pluggy → carteira da Sora. Reusa a carteira já mapeada; senão adota uma
// manual de mesmo nome (sem Pluggy); senão cria. Saldo = valor real do Pluggy
// (cartão = 0, fatura vem das transações). Cartão recebe limite/datas.
async function upsertWallet(grupoId, userId, account, connectorNome) {
  const ehCredito = account.type === 'CREDIT';
  const tipo = ehCredito ? 'Crédito'
             : account.subtype === 'SAVINGS_ACCOUNT' ? 'Poupança' : 'Corrente';
  const nome = (ehCredito
    ? nomeCartao(connectorNome, account)
    : (connectorNome || account.name || account.marketingName || 'Conta')
  ).toString().trim().slice(0, 60);
  const saldo = ehCredito ? 0 : Number(account.balance || 0);
  const extras = ehCredito ? camposCredito(account) : {};

  // 1) já mapeada a esta conta Pluggy?
  const { data: jaMapeada } = await supabase.from('wallets')
    .select('id, nome').eq('grupo_id', grupoId).eq('pluggy_account_id', account.id).maybeSingle();
  if (jaMapeada) {
    await supabase.from('wallets').update({ saldo, tipo, ...extras }).eq('id', jaMapeada.id);
    return jaMapeada.nome;
  }
  // 2) adota uma carteira MANUAL de mesmo nome — só se ainda não for de outra
  // conta Pluggy (.is pluggy_account_id null), senão um cartão "roubava" a
  // carteira de outro e os dois mesclavam num só.
  const { data: mesmoNome } = await supabase.from('wallets')
    .select('id, nome').eq('grupo_id', grupoId).ilike('nome', nome)
    .is('pluggy_account_id', null).maybeSingle();
  if (mesmoNome) {
    await supabase.from('wallets').update({ saldo, tipo, pluggy_account_id: account.id, ...extras }).eq('id', mesmoNome.id);
    return mesmoNome.nome;
  }
  // 3) cria nova
  const row = { grupo_id: grupoId, nome, tipo, saldo, pluggy_account_id: account.id, ...extras };
  if (userId) row.criado_por = userId;
  let { data: nova, error } = await supabase.from('wallets').insert(row).select('nome').single();
  if (error) { // colisão de nome (unique grupo_id,nome) → desambígua
    ({ data: nova } = await supabase.from('wallets')
      .insert({ ...row, nome: `${nome} (Pluggy)`.slice(0, 60) }).select('nome').single());
  }
  return nova?.nome || nome;
}

// Pagamento de fatura do cartão? (lado conta — detecta pela descrição/categoria)
function ehPagamentoFatura(descricao, pluggyCat) {
  const s = `${descricao || ''} ${pluggyCat || ''}`
    .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return /(pagamento\s+de\s+fatura|pagamento\s+fatura|fatura\s+cart|credit\s*card\s*payment|pagamento\s+de\s+cart|pagamento\s+cart)/.test(s);
}

// Mapeia uma transação Pluggy pro formato da Sora.
function mapTx(tx, grupoId, userId, walletNome, ehCredito) {
  const amount = Number(tx.amount || 0);
  // Sinal confiável = tx.type ('DEBIT' = saída, 'CREDIT' = entrada). O `amount`
  // inverte em cartão de crédito, então só usamos o sinal como fallback.
  const t = (tx.type || '').toUpperCase();
  const ehGasto = t === 'DEBIT' ? true : t === 'CREDIT' ? false : amount < 0;
  const descricao = (tx.description || tx.descriptionRaw || '').toString();

  // Pagamento de fatura / quitação = TRANSFERÊNCIA (não entra em receitas/gastos).
  // No cartão, todo CREDIT (pagamento da fatura / estorno) é transferência;
  // na conta, detecta o pagamento da fatura pela descrição.
  const ehTransferencia = (ehCredito && t === 'CREDIT') || ehPagamentoFatura(descricao, tx.category);

  const categoria = ehTransferencia
    ? 'Fatura cartão'
    : categorizar({ descricao, pluggyCategoria: tx.category });

  return {
    id_curto:      idCurto(),
    grupo_id:      grupoId,
    criado_por:    userId || null,
    tipo:          ehGasto ? 'Gasto' : 'Recebimento',
    categoria,
    valor:         Math.abs(amount),
    observacao:    descricao.slice(0, 200),
    carteira_nome: walletNome,
    pago:          true,
    transferencia: ehTransferencia,
    data:          tx.date || new Date().toISOString(),
    pluggy_tx_id:  tx.id,
  };
}

// Insere as novas (dedup por pluggy_tx_id) e CORRIGE as já existentes cujo
// tipo/valor divergem (ex.: imports antigos com o sinal errado). Não mexe em
// categoria/observação das existentes — preserva edições manuais do usuário.
async function inserirNovas(grupoId, userId, walletNome, txs, ehCredito) {
  if (!txs.length) return 0;
  const ids = txs.map(t => t.id).filter(Boolean);
  const existentes = new Map(); // pluggy_tx_id → { id, tipo, valor, transferencia }
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await supabase.from('transacoes')
      .select('id, pluggy_tx_id, tipo, valor, transferencia').in('pluggy_tx_id', ids.slice(i, i + 300));
    (data || []).forEach(d => existentes.set(d.pluggy_tx_id, d));
  }

  const novas = [];
  for (const t of txs) {
    if (!t.id) continue;
    const m = mapTx(t, grupoId, userId, walletNome, ehCredito);
    const ex = existentes.get(t.id);
    if (!ex) { novas.push(m); continue; }
    // Corrige tipo/valor (sinal) e marca transferência (pagamento de fatura)
    // em linhas já importadas. Não toca categoria/observação salvo virar fatura.
    const virouTransf = m.transferencia && !ex.transferencia;
    if (ex.tipo !== m.tipo || Number(ex.valor) !== m.valor || virouTransf) {
      const patch = { tipo: m.tipo, valor: m.valor };
      if (virouTransf) { patch.transferencia = true; patch.categoria = m.categoria; }
      await supabase.from('transacoes').update(patch).eq('id', ex.id);
    }
  }

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
// `dias` = janela de busca de transações (default 90). Retorna diagnóstico:
// { novas, statusPluggy, contas: [{tipo, nome, txs, novas, erro}], erro }.
async function sincronizarItem(itemId, { dias = 90 } = {}) {
  const { data: item } = await supabase.from('pluggy_items').select('*').eq('item_id', itemId).maybeSingle();
  if (!item) { console.warn('[pluggy] item desconhecido:', itemId); return { erro: 'item desconhecido' }; }

  try {
    const info = await pluggy.getItem(itemId);
    const connectorNome = info?.connector?.name || item.connector_nome || null;
    const statusPluggy = info?.status || null; // UPDATED | LOGIN_ERROR | WAITING_USER_INPUT...

    const contas = await pluggy.listarContas(itemId);
    const from = ymd(Date.now() - dias * 864e5);

    let total = 0;
    const detalhe = [];
    for (const acc of contas) {
      try {
        const walletNome = await upsertWallet(item.grupo_id, item.user_id, acc, connectorNome);
        const txs = await pluggy.listarTransacoes(acc.id, from);
        const novas = await inserirNovas(item.grupo_id, item.user_id, walletNome, txs, acc.type === 'CREDIT');
        total += novas;
        detalhe.push({ tipo: acc.type, nome: walletNome, txs: txs.length, novas });
        console.log(`[pluggy] conta ${acc.type}/${acc.subtype || '-'} "${walletNome}": ${txs.length} txs, +${novas} novas (from ${from})`);
      } catch (e) {
        detalhe.push({ tipo: acc.type, erro: e.message });
        console.warn(`[pluggy] conta ${acc.id} (${acc.type}) falhou:`, e.message);
      }
    }

    await supabase.from('pluggy_items').update({
      status: statusPluggy === 'UPDATED' ? 'updated' : (item.status || 'updated'),
      connector_nome: connectorNome,
      ultima_sync: new Date().toISOString(), ultimo_erro: null,
    }).eq('item_id', itemId);
    console.log(`[pluggy] item ${itemId} (${statusPluggy}): ${contas.length} conta(s), +${total} novas`);
    return { novas: total, statusPluggy, contas: detalhe };
  } catch (e) {
    console.warn('[pluggy] sync falhou', itemId, e.message);
    await supabase.from('pluggy_items').update({
      status: 'error', ultimo_erro: String(e.message).slice(0, 300),
    }).eq('item_id', itemId);
    return { erro: e.message };
  }
}

async function marcarErro(itemId, erro) {
  await supabase.from('pluggy_items').update({
    status: 'error', ultimo_erro: (typeof erro === 'string' ? erro : JSON.stringify(erro || {})).slice(0, 300),
  }).eq('item_id', itemId);
}

module.exports = { sincronizarItem, marcarErro };
