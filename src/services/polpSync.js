// =====================================================================
// Sincroniza uma conexão OF (Polp) com a Sora — ESQUELETO.
//   conta/cartão OF → wallet          (via wallets.of_conta_id)
//   transação OF    → transacoes      (dedup por of_tx_id)
//   caixinha/obj.   → of_caixinhas
//   investimento OF → investimentos   (dedup por of_id)
//
// A ORQUESTRAÇÃO e os UPSERTS já estão prontos (reaproveitados do pluggySync).
// Só a camada `normalize*` (extração dos campos da resposta da Polp) está por
// confirmar — é só ajustar esses acessos quando a doc/Swagger chegar. ⚠️
// =====================================================================
const supabase = require('../db/supabase');
const polp     = require('./polp');
const { categorizar } = require('./categorizar');

const PROVIDER = 'polp';
const idCurto = () => Math.random().toString(36).substring(2, 8).toUpperCase();
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const num = (v) => (v == null ? null : Number(v));

// Dia do mês (1..31 — migration 068 já libera até 31).
function dia(iso) {
  if (!iso) return null;
  const d = new Date(iso); if (isNaN(d)) return null;
  return Math.min(31, Math.max(1, d.getUTCDate()));
}
function mapBandeira(brand) {
  const m = { MASTERCARD: 'Mastercard', VISA: 'Visa', ELO: 'Elo', AMEX: 'Amex',
              'AMERICAN EXPRESS': 'Amex', HIPERCARD: 'Hipercard' };
  return m[(brand || '').toString().toUpperCase()] || null;
}

// ─── MAPEAMENTO Polp → Sora (campos confirmados na doc List Accounts/Transactions)
// Conta E cartão vêm do MESMO endpoint (/integrations/:id/accounts); `type`
// (BANK|CREDIT) distingue. Crédito traz os dados de fatura em `credit_data`.
function normalizeConta(acc) {
  const isCard = (acc.type || '').toString().toUpperCase() === 'CREDIT';
  const sub    = (acc.subtype || '').toString().toUpperCase();
  const tipo   = isCard ? 'Crédito' : /SAV|POUP/.test(sub) ? 'Poupança' : 'Corrente';
  const cd     = acc.credit_data || {};
  return {
    externalId: acc.id,
    nome:  (acc.name || acc.marketing_name || 'Conta').toString(),
    tipo,
    saldo: isCard ? 0 : (num(acc.balance) || 0),
    extras: isCard ? {
      limite:         num(cd.limit ?? cd.credit_limit),
      dia_fechamento: dia(cd.close_date ?? cd.balance_close_date),
      dia_vencimento: dia(cd.due_date),
      bandeira:       mapBandeira(cd.brand),
    } : {},
  };
}
// tx: amount NEGATIVO = débito (gasto); type DEBIT|CREDIT confirma. Categoria e
// nome da loja quando vierem.
function normalizeTx(tx) {
  const amount = num(tx.amount) || 0;
  const t = (tx.type || '').toString().toUpperCase(); // DEBIT | CREDIT
  const ehGasto = t === 'DEBIT' ? true : t === 'CREDIT' ? false : amount < 0;
  const meta = tx.credit_card_metadata || {};
  return {
    externalId: tx.id,
    ehGasto,
    descricao:  (tx.description || (tx.merchant && tx.merchant.name) || '').toString(),
    categoriaProvedor: (tx.category && tx.category.description) || null,
    valor:      Math.abs(amount),
    data:       tx.date || tx.created_at || new Date().toISOString(),
    card:       meta.card_number || meta.cardNumber || null,
  };
}
function normalizeCaixinha(c) {
  return {
    externalId: c.id, nome: c.name || c.goal_name || 'Caixinha',
    tipo: c.type || 'caixinha', saldo: num(c.balance) || 0,
    meta_valor: num(c.goal_amount || c.target), atualizado_em: c.updated_at || null,
  };
}
function normalizeInvestimento(i) {
  const aportado = num(i.amount || i.invested) || 0;
  const atual    = num(i.balance || i.value) || aportado;
  return {
    externalId: i.id, tipo: i.type || 'Renda Fixa', nome: i.name || i.product || 'Investimento',
    ticker: i.ticker || null, valor_aportado: aportado, valor_atual: atual,
    data_compra: i.date || i.purchased_at || new Date().toISOString(),
  };
}

// ─── upserts na Sora (lógica REAL, agregador-agnóstica) ──────────────────────
async function upsertWallet(grupoId, userId, n) {
  const nome = (n.nome || 'Conta').toString().trim().slice(0, 60);
  const extras = Object.fromEntries(Object.entries(n.extras || {}).filter(([, v]) => v != null));

  const { data: ja } = await supabase.from('wallets')
    .select('id, nome').eq('grupo_id', grupoId).eq('of_conta_id', n.externalId).maybeSingle();
  if (ja) {
    await supabase.from('wallets').update({ saldo: n.saldo, tipo: n.tipo, ...extras }).eq('id', ja.id);
    return ja.nome;
  }
  // adota carteira manual de mesmo nome (sem vínculo OF) — evita duplicar
  const { data: mesmoNome } = await supabase.from('wallets')
    .select('id, nome').eq('grupo_id', grupoId).ilike('nome', nome).is('of_conta_id', null).maybeSingle();
  if (mesmoNome) {
    await supabase.from('wallets')
      .update({ saldo: n.saldo, tipo: n.tipo, of_conta_id: n.externalId, of_provider: PROVIDER, ...extras })
      .eq('id', mesmoNome.id);
    return mesmoNome.nome;
  }
  const row = { grupo_id: grupoId, nome, tipo: n.tipo, saldo: n.saldo,
                of_conta_id: n.externalId, of_provider: PROVIDER, ...extras };
  if (userId) row.criado_por = userId;
  let { data: nova, error } = await supabase.from('wallets').insert(row).select('nome').single();
  if (error) ({ data: nova } = await supabase.from('wallets')
    .insert({ ...row, nome: `${nome} (OF)`.slice(0, 60) }).select('nome').single());
  return nova?.nome || nome;
}

async function inserirTransacoes(grupoId, userId, walletNome, txs, ehCredito) {
  if (!txs.length) return 0;
  const ids = txs.map(t => t.externalId).filter(Boolean);
  const existentes = new Set();
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await supabase.from('transacoes')
      .select('of_tx_id').in('of_tx_id', ids.slice(i, i + 300));
    (data || []).forEach(d => existentes.add(d.of_tx_id));
  }
  const novas = txs.filter(t => t.externalId && !existentes.has(t.externalId)).map(t => {
    const ehTransf = ehCredito && !t.ehGasto; // pagamento de fatura/estorno no cartão = transferência
    return {
      id_curto: idCurto(), grupo_id: grupoId, criado_por: userId || null,
      tipo: t.ehGasto ? 'Gasto' : 'Recebimento',
      categoria: ehTransf ? 'Fatura cartão' : categorizar({ descricao: t.descricao, pluggyCategoria: t.categoriaProvedor }),
      valor: t.valor, observacao: (t.descricao || '').slice(0, 200),
      carteira_nome: walletNome, pago: true, transferencia: ehTransf,
      data: t.data, of_tx_id: t.externalId, of_card: t.card || null,
    };
  });
  if (!novas.length) return 0;
  let { error } = await supabase.from('transacoes').insert(novas);
  if (error) { // fallback 1 a 1 (unique of_tx_id ignora corridas)
    let ok = 0;
    for (const row of novas) { const { error: e } = await supabase.from('transacoes').insert(row); if (!e) ok++; }
    return ok;
  }
  return novas.length;
}

async function upsertCaixinha(conexao, n) {
  await supabase.from('of_caixinhas').upsert({
    conexao_id: conexao.id, user_id: conexao.user_id, grupo_id: conexao.grupo_id, provider: PROVIDER,
    external_id: n.externalId, nome: n.nome, tipo: n.tipo, saldo: n.saldo,
    meta_valor: n.meta_valor, atualizado_em: n.atualizado_em,
  }, { onConflict: 'provider,external_id' });
}

async function upsertInvestimento(grupoId, n) {
  await supabase.from('investimentos').upsert({
    grupo_id: grupoId, of_id: n.externalId, of_provider: PROVIDER, origem: 'of',
    tipo: n.tipo, nome: n.nome, ticker: n.ticker,
    valor_aportado: n.valor_aportado, valor_atual: n.valor_atual, data_compra: n.data_compra,
  }, { onConflict: 'of_id' });
}

// Sincroniza uma conexão inteira. Tolerante: falha numa parte não derruba o resto.
async function sincronizarConexao(externalId, { dias = 90 } = {}) {
  const { data: conexao } = await supabase.from('of_conexoes')
    .select('*').eq('provider', PROVIDER).eq('external_id', externalId).maybeSingle();
  if (!conexao) return { erro: 'conexão desconhecida' };
  const { grupo_id: grupoId, user_id: userId } = conexao;
  const from = ymd(Date.now() - dias * 864e5);

  // Estado REAL na Polp: não adianta importar se o usuário ainda não autorizou
  // (WAITING_USER_INPUT) ou o login falhou. Reflete o status e sai — sem marcar
  // "conectado" (o bug anterior: buscava 0 contas e dizia sucesso).
  let integ = null;
  try { integ = await polp.getIntegracao(externalId); } catch { /* segue e tenta importar */ }
  const st = ((integ && (integ.status || integ.execution_status)) || '').toString().toUpperCase();
  if (st && st !== 'UPDATED' && st !== 'OUTDATED') {
    await supabase.from('of_conexoes').update({
      status: st.toLowerCase(),
      ultimo_erro: st === 'LOGIN_ERROR' ? 'Falha no login com o banco. Reconecte.' : null,
    }).eq('id', conexao.id);
    return { pendente: st, urlToAuthenticate: (integ && integ.url_to_authenticate) || null, novas: 0 };
  }

  try {
    let novasTx = 0;
    const detalhe = [];

    // Contas + cartões (mesmo endpoint, type BANK|CREDIT) → wallets + transações.
    const contas = await polp.listarContas(externalId);
    for (const raw of contas) {
      try {
        const n = normalizeConta(raw);
        const walletNome = await upsertWallet(grupoId, userId, n);
        const txsRaw = await polp.listarTransacoes(n.externalId, from);
        const novas = await inserirTransacoes(grupoId, userId, walletNome, txsRaw.map(normalizeTx), n.tipo === 'Crédito');
        novasTx += novas;
        detalhe.push({ conta: walletNome, txs: txsRaw.length, novas });
      } catch (e) { detalhe.push({ erro: e.message }); }
    }

    // Investimentos
    try { for (const i of await polp.listarInvestimentos(externalId)) await upsertInvestimento(grupoId, normalizeInvestimento(i)); }
    catch (e) { console.warn('[polp] investimentos:', e.message); }

    await supabase.from('of_conexoes').update({
      status: 'updated', ultima_sync: new Date().toISOString(), ultimo_erro: null,
    }).eq('id', conexao.id);
    return { novas: novasTx, contas: detalhe };
  } catch (e) {
    await supabase.from('of_conexoes').update({
      status: 'error', ultimo_erro: String(e.message).slice(0, 300),
    }).eq('id', conexao.id);
    return { erro: e.message };
  }
}

module.exports = { sincronizarConexao };
