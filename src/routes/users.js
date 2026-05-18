const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const norm     = p => p?.replace(/\D/g, '');

// GET /api/user/:phone
router.get('/:phone', auth, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users')
      .select('*, grupos!users_grupo_ativo_fkey(id, nome)')
      .eq('phone', norm(req.params.phone)).single();
    if (!user) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(user);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/user/update-plan — chamado pelo Stripe webhook
router.post('/update-plan', auth, async (req, res) => {
  try {
    const { phone, email, plano, intervalo, valido_ate } = req.body;
    if (!phone) return res.status(400).json({ erro: 'phone obrigatório' });
    await supabase.from('users').upsert(
      { phone: norm(phone), email, plano, intervalo, valido_ate },
      { onConflict: 'phone' }
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;