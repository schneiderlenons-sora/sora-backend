// ─────────────────────────────────────────────────────────────────
// Marcas personalizadas — logo de loja custom (por grupo), casada por NOME
// no texto da transação. Consumida pelo painel (CategoriaIcon) como a marca
// de maior prioridade. Migration 083.
// ─────────────────────────────────────────────────────────────────
const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');

async function getGrupoId(req) {
  const { data } = await supabase.from('users')
    .select('grupo_ativo').eq('id', req.authUser?.id || '__none__').single();
  return data?.grupo_ativo || null;
}

// GET /api/marcas/:phone — lista as marcas do grupo
router.get('/:phone', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('marcas_personalizadas')
      .select('id, termo, logo_url').eq('grupo_id', grupoId)
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/marcas  { phone, termo, logo_url }
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const grupoId = req.grupoId;
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const termo = String(req.body?.termo || '').trim().slice(0, 60);
    const logo  = String(req.body?.logo_url || '');
    if (termo.length < 2) return res.status(400).json({ erro: 'Informe o nome da loja (mín. 2 letras).' });
    if (!/^data:image\//.test(logo)) return res.status(400).json({ erro: 'Envie uma imagem válida.' });
    if (logo.length > 400000) return res.status(400).json({ erro: 'Logo muito pesada — use uma imagem menor.' });
    const { data, error } = await supabase.from('marcas_personalizadas')
      .insert({ grupo_id: grupoId, user_id: req.userId, termo, logo_url: logo })
      .select('id, termo, logo_url').single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/marcas/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    await supabase.from('marcas_personalizadas').delete()
      .eq('id', req.params.id).eq('grupo_id', grupoId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
