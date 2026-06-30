const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const norm     = p => p?.replace(/\D/g, '');

async function getGrupoId(req) {
  const { data } = await supabase.from('users')
    .select('grupo_ativo').eq('id', req.authUser?.id || '__none__').single();
  return data?.grupo_ativo || null;
}

router.get('/:phone', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    const mes = req.query.mes || new Date().toISOString().slice(0,7);
    const { data: user } = await supabase.from('users')
      .select('meta_mensal, meta_mensal_ativo, meta_mensal_alerta_ativo, meta_mensal_alerta_pct')
      .eq('id', req.authUser?.id || '__none__').single();
    const { data: limites } = await supabase.from('category_limits')
      .select('*').eq('grupo_id', grupoId).eq('mes_referencia', mes);
    res.json({
      meta_mensal:               user?.meta_mensal || 0,
      meta_mensal_ativo:         user?.meta_mensal_ativo ?? true,
      meta_mensal_alerta_ativo:  user?.meta_mensal_alerta_ativo ?? true,
      meta_mensal_alerta_pct:    user?.meta_mensal_alerta_pct ?? 80,
      categorias:                limites || [],
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/geral', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, valor, ativo, alerta_ativo, alerta_pct } = req.body;
    const patch = { meta_mensal: valor };
    if (typeof ativo === 'boolean')         patch.meta_mensal_ativo = ativo;
    if (typeof alerta_ativo === 'boolean')  patch.meta_mensal_alerta_ativo = alerta_ativo;
    if (typeof alerta_pct === 'number')     patch.meta_mensal_alerta_pct = alerta_pct;
    await supabase.from('users').update(patch).eq('id', req.authUser?.id || '__none__');
    res.json({ ok: true, ...patch });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/categoria', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, categoria, limite_mensal, percentual_alerta, ativo, mes_referencia } = req.body;
    const grupoId = await getGrupoId(req);
    const mes = mes_referencia || new Date().toISOString().slice(0,7);
    const payload = {
      grupo_id: grupoId, categoria, limite_mensal,
      percentual_alerta: percentual_alerta || 80,
      mes_referencia: mes,
    };
    if (typeof ativo === 'boolean') payload.ativo = ativo;
    const { data } = await supabase.from('category_limits')
      .upsert(payload, { onConflict: 'grupo_id,categoria,mes_referencia' })
      .select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await supabase.from('category_limits').delete()
      .eq('id', req.params.id).eq('grupo_id', req.authUser?.grupoAtivo || '__nenhum__');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;