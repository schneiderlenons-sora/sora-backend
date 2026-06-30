const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { enviarBoasVindas } = require('../services/welcome');
const norm     = p => p?.replace(/\D/g, '');

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

    // Número já vinculado a OUTRA conta → 409 pro frontend bloquear o cadastro
    // com mensagem clara (em vez de seguir pro pagamento com a conta quebrada).
    if (resultado.motivo === 'phone_em_uso') {
      return res.status(409).json({
        erro: 'Esse WhatsApp já está vinculado a outra conta. Faça login nessa conta ou use outro número.',
        motivo: 'phone_em_uso',
      });
    }

    res.json(resultado);
  } catch (err) {
    console.error('[/api/user/welcome] erro:', err);
    res.status(500).json({ erro: err.message });
  }
});

// =====================================================================
// Resumos proativos (semanal/mensal) — preferência do usuário logado.
// GET  /api/user/resumos        → { semanal, mensal }
// POST /api/user/resumos { semanal?, mensal? }
// =====================================================================
router.get('/resumos', auth, async (req, res) => {
  try {
    const user_id = req.authUser?.id;
    const { data, error } = await supabase
      .from('users').select('resumo_semanal, resumo_mensal').eq('id', user_id).maybeSingle();
    if (error) throw error; // coluna pode não existir antes da migration 044
    res.json({ semanal: data?.resumo_semanal ?? true, mensal: data?.resumo_mensal ?? true });
  } catch {
    res.json({ semanal: true, mensal: true }); // default tolerante
  }
});

router.post('/resumos', auth, async (req, res) => {
  try {
    const user_id = req.authUser?.id;
    const patch = {};
    if (typeof req.body?.semanal === 'boolean') patch.resumo_semanal = req.body.semanal;
    if (typeof req.body?.mensal === 'boolean') patch.resumo_mensal = req.body.mensal;
    if (Object.keys(patch).length) await supabase.from('users').update(patch).eq('id', user_id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// =====================================================================
// GET  /api/user/avisos → todas as preferências de aviso (central de avisos)
// POST /api/user/avisos { ...campos } → atualiza as enviadas
// =====================================================================
const COLS_AVISOS = [
  'avisos_ativos', 'resumo_semanal', 'resumo_mensal',
  'habito_lembrete_ativo', 'habito_lembrete_horario',
  'agenda_briefing_ativo', 'agenda_briefing_horario',
  'lembretes_ativos', 'lembretes_dividas',
];
const DEFAULTS_AVISOS = {
  avisos_ativos: true, resumo_semanal: true, resumo_mensal: true,
  habito_lembrete_ativo: false, habito_lembrete_horario: '21:00',
  agenda_briefing_ativo: false, agenda_briefing_horario: '07:00',
  lembretes_ativos: true, lembretes_dividas: true,
};
const horarioOk = (h) => typeof h === 'string' && /^\d{2}:\d{2}$/.test(h);

router.get('/avisos', auth, async (req, res) => {
  try {
    const user_id = req.authUser?.id;
    const { data, error } = await supabase
      .from('users').select(COLS_AVISOS.join(', ')).eq('id', user_id).maybeSingle();
    if (error) throw error;
    const out = { ...DEFAULTS_AVISOS };
    for (const c of COLS_AVISOS) if (data?.[c] != null) out[c] = data[c];
    res.json(out);
  } catch {
    res.json({ ...DEFAULTS_AVISOS }); // tolerante a colunas ausentes
  }
});

router.post('/avisos', auth, async (req, res) => {
  try {
    const user_id = req.authUser?.id;
    const b = req.body || {};
    const patch = {};
    for (const c of ['avisos_ativos', 'resumo_semanal', 'resumo_mensal',
                     'habito_lembrete_ativo', 'agenda_briefing_ativo',
                     'lembretes_ativos', 'lembretes_dividas']) {
      if (typeof b[c] === 'boolean') patch[c] = b[c];
    }
    if (horarioOk(b.habito_lembrete_horario)) patch.habito_lembrete_horario = b.habito_lembrete_horario;
    if (horarioOk(b.agenda_briefing_horario)) patch.agenda_briefing_horario = b.agenda_briefing_horario;
    if (!Object.keys(patch).length) return res.json({ ok: true });

    let { error } = await supabase.from('users').update(patch).eq('id', user_id);
    if (error && 'avisos_ativos' in patch) { // pré-migration 055: salva o resto
      const { avisos_ativos, ...resto } = patch;
      if (Object.keys(resto).length) await supabase.from('users').update(resto).eq('id', user_id);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// GET /api/user/:phone — POR ÚLTIMO: rota curinga (:phone casa qualquer
// segmento). Se vier antes, captura /resumos, /avisos, etc. e quebra tudo.
router.get('/:phone', auth, async (req, res) => {
  try {
    const { data: user } = await supabase.from('users')
      .select('*, grupos!users_grupo_ativo_fkey(id, nome)')
      .eq('id', req.authUser?.id || '__none__').single();
    if (!user) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(user);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;