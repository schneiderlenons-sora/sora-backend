const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const norm     = p => p?.replace(/\D/g, '');

async function getGrupoId(phone) {
  const { data } = await supabase.from('users')
    .select('grupo_ativo').eq('phone', norm(phone)).single();
  return data?.grupo_ativo || null;
}

router.get('/:phone', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('categorias')
      .select('*, parent:parent_id(id,nome)').eq('grupo_id', grupoId)
      .eq('ativa', true).order('nome');
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, nome, parent_id, icone, cor } = req.body;
    const grupoId = await getGrupoId(phone);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('categorias')
      .insert({ grupo_id: grupoId, nome, parent_id: parent_id || null, icone: icone || '📦', cor: cor || '#808080' })
      .select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { nome, icone, cor, arquivada } = req.body;
    const { data } = await supabase.from('categorias')
      .update({ nome, icone, cor, arquivada }).eq('id', req.params.id).select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await supabase.from('categorias').update({ ativa: false }).eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Restaura categorias padrão para o grupo do usuário (chama RPC criar_categorias_padrao)
router.post('/restaurar-padrao/:phone', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: 'Grupo ativo não encontrado para este telefone.' });

    const { error: rpcErr } = await supabase.rpc('criar_categorias_padrao', { p_grupo_id: grupoId });
    if (rpcErr) return res.status(500).json({ erro: `Falha na função criar_categorias_padrao: ${rpcErr.message}` });

    const { data: categorias } = await supabase.from('categorias')
      .select('*').eq('grupo_id', grupoId).eq('ativa', true);

    res.json({ ok: true, total: categorias?.length || 0 });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;