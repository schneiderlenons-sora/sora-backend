const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const { debitarConta } = require('../services/contaDebito');

const norm = p => p?.replace(/\D/g, '');

async function getUser(phone) {
  const { data } = await supabase.from('users')
    .select('id, grupo_ativo').eq('phone', norm(phone)).maybeSingle();
  return data;
}

// GET /api/metas/:phone — lista todas as metas + aportes dos últimos 12 meses pra gráfico
router.get('/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    const { data: metas, error } = await supabase.from('metas')
      .select('*').eq('grupo_id', user.grupo_ativo)
      .neq('status', 'arquivado')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Aportes dos últimos 12 meses por meta (pra trajetória do chart)
    const ids = (metas || []).map(m => m.id);
    let aportesPorMeta = {};
    if (ids.length) {
      const doze = new Date();
      doze.setMonth(doze.getMonth() - 12);
      const { data: ap } = await supabase.from('meta_aportes')
        .select('meta_id, valor, tipo, data')
        .in('meta_id', ids)
        .gte('data', doze.toISOString().slice(0, 10))
        .order('data', { ascending: true });
      (ap || []).forEach(a => {
        if (!aportesPorMeta[a.meta_id]) aportesPorMeta[a.meta_id] = [];
        aportesPorMeta[a.meta_id].push(a);
      });
    }

    const result = (metas || []).map(m => ({ ...m, aportes: aportesPorMeta[m.id] || [] }));
    res.json(result);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/metas — cria
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { titulo, descricao, valor_objetivo, valor_atual, data_alvo, imagem_url, cor, icone } = req.body;
    if (!titulo?.trim()) return res.status(400).json({ erro: 'Título obrigatório.' });
    if (!valor_objetivo || valor_objetivo <= 0) return res.status(400).json({ erro: 'Valor objetivo inválido.' });

    const { data, error } = await supabase.from('metas').insert({
      grupo_id:        req.grupoId,
      criado_por:      req.userId,
      titulo:          titulo.trim(),
      descricao:       descricao || null,
      valor_objetivo:  parseFloat(valor_objetivo),
      valor_atual:     parseFloat(valor_atual || 0),
      data_alvo:       data_alvo || null,
      imagem_url:      imagem_url || null,
      cor:             cor || '#61D17B',
      icone:           icone || '🎯',
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// PUT /api/metas/:id — edita
router.put('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const allowed = ['titulo','descricao','valor_objetivo','valor_atual','data_alvo','imagem_url','cor','icone','status'];
    const patch = {};
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k];
    patch.updated_at = new Date().toISOString();

    const { data, error } = await supabase.from('metas')
      .update(patch).eq('id', req.params.id).eq('grupo_id', req.grupoId).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/metas/:id
router.delete('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { error } = await supabase.from('metas').delete().eq('id', req.params.id).eq('grupo_id', req.grupoId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/metas/:id/aporte — registra aporte e atualiza valor_atual
router.post('/:id/aporte', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { valor, observacao, data } = req.body;
    const v = parseFloat(valor);
    if (!v || v <= 0) return res.status(400).json({ erro: 'Valor inválido.' });

    const { data: meta } = await supabase.from('metas')
      .select('titulo, valor_atual, valor_objetivo').eq('id', req.params.id).maybeSingle();
    if (!meta) return res.status(404).json({ erro: 'Meta não encontrada.' });

    const novoValor = parseFloat(meta.valor_atual || 0) + v;
    const novoStatus = novoValor >= parseFloat(meta.valor_objetivo) ? 'concluido' : 'ativo';

    await supabase.from('meta_aportes').insert({
      meta_id:    req.params.id,
      user_id:    req.userId,
      valor:      v,
      tipo:       'aporte',
      observacao: observacao || null,
      data:       data || new Date().toISOString().slice(0, 10),
    });

    const { data: atualizada } = await supabase.from('metas')
      .update({ valor_atual: novoValor, status: novoStatus, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();

    // Opcional: desconta de uma conta e registra a saída nas transações.
    let debito = null;
    if (req.body.wallet_id) {
      try {
        debito = await debitarConta({
          grupoId: req.grupoId, walletId: req.body.wallet_id, valor: v,
          categoria: 'Metas', observacao: `Aporte: ${meta.titulo || 'meta'}`,
          userId: req.userId, data,
        });
      } catch (e) { debito = { erro: e.message }; }
    }
    res.json({ ...atualizada, debito });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/metas/:id/resgate — registra resgate e diminui valor_atual
router.post('/:id/resgate', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { valor, observacao, data } = req.body;
    const v = parseFloat(valor);
    if (!v || v <= 0) return res.status(400).json({ erro: 'Valor inválido.' });

    const { data: meta } = await supabase.from('metas')
      .select('valor_atual, valor_objetivo').eq('id', req.params.id).maybeSingle();
    if (!meta) return res.status(404).json({ erro: 'Meta não encontrada.' });
    if (v > parseFloat(meta.valor_atual)) return res.status(400).json({ erro: 'Valor maior que o disponível.' });

    const novoValor = parseFloat(meta.valor_atual) - v;
    const novoStatus = novoValor >= parseFloat(meta.valor_objetivo) ? 'concluido' : 'ativo';

    await supabase.from('meta_aportes').insert({
      meta_id:    req.params.id,
      user_id:    req.userId,
      valor:      v,
      tipo:       'resgate',
      observacao: observacao || null,
      data:       data || new Date().toISOString().slice(0, 10),
    });

    const { data: atualizada } = await supabase.from('metas')
      .update({ valor_atual: novoValor, status: novoStatus, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    res.json(atualizada);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
