const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');

const norm = p => p?.replace(/\D/g, '');

async function getUser(phone) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo').eq('phone', norm(phone)).maybeSingle();
  return data;
}

// GET /api/transacoes/:phone?mes=2026-05&tipo=Gasto&categoria=Mercado&limit=50&offset=0&criado_por_me=true&criado_por_phone=XX
router.get('/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado' });
    const grupoId = user.grupo_ativo;

    const { mes, tipo, categoria, limit = 50, offset = 0, criado_por_me, criado_por_phone } = req.query;

    // Tenta com JOIN — se a FK não existir no schema, cai para SELECT * sem join
    let query = supabase.from('transacoes')
      .select('*, criador:users!transacoes_criado_por_fkey(id, name, phone)', { count: 'exact' })
      .eq('grupo_id', grupoId)
      .order('data', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (mes)       query = query.gte('data', `${mes}-01`).lte('data', `${mes}-31`);
    if (tipo)      query = query.eq('tipo', tipo);
    if (categoria) query = query.eq('categoria', categoria);

    if (criado_por_me === 'true') {
      query = query.eq('criado_por', user.id);
    } else if (criado_por_phone) {
      const { data: outro } = await supabase.from('users')
        .select('id').eq('phone', norm(criado_por_phone)).maybeSingle();
      if (outro?.id) query = query.eq('criado_por', outro.id);
    }

    let { data, count, error } = await query;
    if (error) {
      // Fallback se a FK ainda não foi criada: refaz sem o embed
      console.warn('[transacoes] join fallback:', error.message);
      let q2 = supabase.from('transacoes').select('*', { count: 'exact' })
        .eq('grupo_id', grupoId)
        .order('data', { ascending: false })
        .range(Number(offset), Number(offset) + Number(limit) - 1);
      if (mes)       q2 = q2.gte('data', `${mes}-01`).lte('data', `${mes}-31`);
      if (tipo)      q2 = q2.eq('tipo', tipo);
      if (categoria) q2 = q2.eq('categoria', categoria);
      if (criado_por_me === 'true') q2 = q2.eq('criado_por', user.id);
      const r = await q2;
      data = r.data; count = r.count;
    }
    // Alias wallet_nome → o frontend lê esse campo; no banco a coluna é carteira_nome
    const transacoes = (data || []).map(t => ({ ...t, wallet_nome: t.carteira_nome }));
    res.json({ transacoes, total: count || 0 });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/transacoes — cria transação pelo painel
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, tipo, categoria, valor, observacao, carteira_nome, data, pago } = req.body;
    const grupoId = req.grupoId;
    const userId  = req.userId;

    const idCurto = Math.random().toString(36).substring(2, 8).toUpperCase();

    const { data: tx, error } = await supabase.from('transacoes').insert({
      id_curto:      idCurto,
      grupo_id:      grupoId,
      criado_por:    userId,
      tipo,
      categoria,
      valor:         parseFloat(valor),
      observacao:    observacao || '',
      carteira_nome: carteira_nome || 'Dinheiro',
      pago:          pago !== false,
      data:          data || new Date().toISOString(),
    }).select().single();

    if (error) throw error;

    if (tx.pago) {
      const mult = tipo === 'Gasto' ? -1 : 1;
      const { data: wallet } = await supabase.from('wallets')
        .select('id, saldo').eq('grupo_id', grupoId).ilike('nome', carteira_nome || 'Dinheiro').maybeSingle();
      if (wallet) {
        await supabase.from('wallets')
          .update({ saldo: wallet.saldo + (parseFloat(valor) * mult) }).eq('id', wallet.id);
      }
    }

    res.json(tx);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/transacoes/bulk — importação em massa (OFX/CSV)
router.post('/bulk', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { transacoes } = req.body;
    if (!Array.isArray(transacoes) || transacoes.length === 0) {
      return res.status(400).json({ erro: 'Lista de transações vazia.' });
    }
    if (transacoes.length > 1000) {
      return res.status(400).json({ erro: 'Limite de 1000 transações por importação.' });
    }

    const rows = transacoes.map(t => ({
      id_curto:      Math.random().toString(36).substring(2, 8).toUpperCase(),
      grupo_id:      req.grupoId,
      criado_por:    req.userId,
      tipo:          t.tipo === 'Recebimento' ? 'Recebimento' : 'Gasto',
      categoria:     t.categoria || '📦 Outros',
      valor:         Math.abs(parseFloat(t.valor) || 0),
      observacao:    (t.observacao || '').toString().slice(0, 200),
      carteira_nome: t.carteira_nome || 'Dinheiro',
      pago:          t.pago !== false,
      data:          t.data,
    }));

    const { data, error } = await supabase.from('transacoes').insert(rows).select('id');
    if (error) throw error;
    res.json({ inserted: data?.length || 0 });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// PUT /api/transacoes/:id — edita (update PARCIAL: só os campos enviados)
router.put('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { tipo, categoria, valor, observacao, carteira_nome, data, pago } = req.body;
    const patch = {};
    if (tipo !== undefined)          patch.tipo = tipo;
    if (categoria !== undefined)     patch.categoria = categoria;
    if (valor !== undefined)         patch.valor = parseFloat(valor);
    if (observacao !== undefined)    patch.observacao = observacao;
    if (carteira_nome !== undefined) patch.carteira_nome = carteira_nome;
    if (data !== undefined)          patch.data = data;
    if (pago !== undefined)          patch.pago = pago;

    const { data: tx, error } = await supabase.from('transacoes')
      .update(patch).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(tx);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/transacoes/:id
router.delete('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { data: tx } = await supabase.from('transacoes')
      .select('*').eq('id', req.params.id).maybeSingle();

    if (tx?.pago) {
      const mult = tx.tipo === 'Gasto' ? 1 : -1;
      const { data: wallet } = await supabase.from('wallets')
        .select('id, saldo').eq('grupo_id', tx.grupo_id).ilike('nome', tx.carteira_nome).maybeSingle();
      if (wallet) {
        await supabase.from('wallets')
          .update({ saldo: wallet.saldo + (tx.valor * mult) }).eq('id', wallet.id);
      }
    }

    await supabase.from('transacoes').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/transacoes/:phone/resumo?mes=2026-05&criado_por_me=true
router.get('/:phone/resumo', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado' });

    const mes = req.query.mes || new Date().toISOString().slice(0, 7);
    let q = supabase.from('transacoes')
      .select('tipo, categoria, valor, criado_por')
      .eq('grupo_id', user.grupo_ativo)
      .gte('data', `${mes}-01`).lte('data', `${mes}-31`);
    if (req.query.criado_por_me === 'true') q = q.eq('criado_por', user.id);
    const { data: rows } = await q;

    let receitas = 0, gastos = 0;
    const porCategoria = {};
    const porMembro    = {};

    (rows || []).forEach(r => {
      if (r.tipo === 'Gasto') {
        gastos += r.valor;
        porCategoria[r.categoria] = (porCategoria[r.categoria] || 0) + r.valor;
        if (r.criado_por) porMembro[r.criado_por] = (porMembro[r.criado_por] || 0) + r.valor;
      } else {
        receitas += r.valor;
      }
    });

    // Resolve nomes dos membros via JOIN simples
    const ids = Object.keys(porMembro);
    let nomes = {};
    if (ids.length) {
      const { data: usrs } = await supabase.from('users')
        .select('id, name, phone').in('id', ids);
      (usrs || []).forEach(u => { nomes[u.id] = { name: u.name, phone: u.phone }; });
    }

    res.json({
      receitas, gastos,
      saldo: receitas - gastos,
      por_categoria: Object.entries(porCategoria)
        .map(([categoria, total]) => ({ categoria, total }))
        .sort((a, b) => b.total - a.total),
      por_membro: Object.entries(porMembro)
        .map(([user_id, total]) => ({ user_id, total, name: nomes[user_id]?.name || 'Desconhecido', phone: nomes[user_id]?.phone }))
        .sort((a, b) => b.total - a.total),
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
