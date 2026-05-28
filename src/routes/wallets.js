const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { exigirPermissao } = require('../middlewares/permissao');
const norm     = p => p?.replace(/\D/g, '');

// Tenta as duas variantes de número brasileiro (com/sem 9º dígito)
function variantesPhone(phone) {
  const p = norm(phone) || '';
  const variantes = [p];
  if (p.length === 13 && p.startsWith('55'))
    variantes.push(p.slice(0, 4) + p.slice(5));
  if (p.length === 12 && p.startsWith('55'))
    variantes.push(p.slice(0, 4) + '9' + p.slice(4));
  return variantes;
}

async function getGrupoId(phone) {
  for (const variante of variantesPhone(phone)) {
    const { data } = await supabase.from('users')
      .select('grupo_ativo').eq('phone', variante).maybeSingle();
    if (data?.grupo_ativo) return data.grupo_ativo;
  }
  return null;
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