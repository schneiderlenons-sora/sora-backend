const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { enviarBoasVindas } = require('../services/welcome');
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

// =====================================================================
// POST /api/user/welcome
// Dispara mensagem de boas-vindas no WhatsApp do usuário.
// Chamado pelo frontend logo após o usuário vincular o número
// em /vincular-whatsapp. Idempotente (não reenvia se welcomed_at != null).
//
// Body:
//   { user_id, phone, nome?, force? }
// =====================================================================
router.post('/welcome', auth, async (req, res) => {
  try {
    const { phone, nome, force } = req.body;
    // Vincula sempre ao usuário AUTENTICADO (nunca a um user_id do body).
    const user_id = req.authUser?.id;
    if (!user_id || !phone) {
      return res.status(400).json({ erro: 'phone obrigatório' });
    }

    const resultado = await enviarBoasVindas({
      user_id,
      phone: norm(phone),
      nome,
      force: !!force,
    });

    res.json(resultado);
  } catch (err) {
    console.error('[/api/user/welcome] erro:', err);
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;