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

// GET /api/recorrencias/:phone — lista as recorrências ativas do grupo
router.get('/:phone', auth, async (req, res) => {
  try {
    const user = await getUser(req.params.phone);
    if (!user?.grupo_ativo) return res.status(404).json({ erro: 'Usuário não encontrado' });
    const { data, error } = await supabase.from('recorrencias')
      .select('id, tipo, categoria, valor, dia_vencimento, descricao, carteira, ativa')
      .eq('grupo_id', user.grupo_ativo)
      .eq('ativa', true)
      .order('tipo', { ascending: true })
      .order('dia_vencimento', { ascending: true });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/recorrencias — cria gasto/receita fixa (body inclui phone)
router.post('/', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    const { tipo, categoria, valor, dia_vencimento, descricao, carteira } = req.body;
    const ehReceita = tipo === 'Recebimento';
    const { data, error } = await supabase.from('recorrencias').insert({
      grupo_id:       req.grupoId,
      tipo:           ehReceita ? 'Recebimento' : 'Gasto',
      categoria:      categoria || (ehReceita ? '💼 Salário' : 'Outros'),
      valor:          parseFloat(valor),
      dia_vencimento: Math.max(1, Math.min(28, parseInt(dia_vencimento, 10) || 5)),
      descricao:      (descricao || '').toString().slice(0, 120),
      carteira:       carteira || 'Dinheiro',
      ativa:          true,
    }).select().single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// DELETE /api/recorrencias/:id — cancela (ativa=false). phone no body p/ permissão.
router.delete('/:id', auth, exigirPermissao('admin', 'escrita'), async (req, res) => {
  try {
    await supabase.from('recorrencias').update({ ativa: false })
      .eq('id', req.params.id).eq('grupo_id', req.grupoId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
