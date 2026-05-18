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

// GET /api/wallets/:phone
router.get('/:phone', auth, async (req, res) => {
  try {
    const grupoId = await getGrupoId(req.params.phone);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('wallets')
      .select('*').eq('grupo_id', grupoId).order('nome');
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/wallets
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { phone, nome, tipo, saldo, limite } = req.body;
    const grupoId = await getGrupoId(phone);
    if (!grupoId) return res.status(404).json({ erro: 'Não encontrado' });
    const { data } = await supabase.from('wallets')
      .upsert({ grupo_id: grupoId, nome, tipo, saldo, limite }, { onConflict: 'grupo_id,nome' })
      .select().single();
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/wallets/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    await supabase.from('wallets').delete().eq('id', req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;