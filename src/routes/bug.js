const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const auth     = require('../middlewares/auth');
const { enviarTexto, enviarImagem } = require('../services/zapi');

// WhatsApp que recebe os relatos (configurável; fallback = suporte da Sora).
const SUPORTE_PHONE = (process.env.SUPORTE_PHONE || '5532999167475').replace(/\D/g, '');

// =====================================================================
// POST /api/bug
// Recebe um relato de bug do usuário logado, guarda no histórico
// (bug_reports) e encaminha pro WhatsApp de suporte via Z-API.
//
// Body: { mensagem: string, imagem?: string (data URI base64, opcional) }
// =====================================================================
router.post('/', auth, async (req, res) => {
  try {
    const user_id = req.authUser?.id;
    const mensagem = (req.body?.mensagem || '').trim();
    const imagem   = req.body?.imagem;

    if (!mensagem) {
      return res.status(400).json({ erro: 'Descreva o problema antes de enviar.' });
    }
    if (mensagem.length > 4000) {
      return res.status(400).json({ erro: 'Mensagem muito longa (máx. 4000 caracteres).' });
    }

    const temImagem = typeof imagem === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(imagem);

    // Contexto do usuário pra facilitar o atendimento.
    let nome = null, phone = null, email = null, plano = null;
    if (user_id) {
      const { data: u } = await supabase
        .from('users').select('name, phone, email, plano')
        .eq('id', user_id).maybeSingle();
      nome = u?.name; phone = u?.phone; email = u?.email; plano = u?.plano;
    }

    // 1) Histórico (backup — não depende do WhatsApp entregar).
    let id = null;
    try {
      const { data: row } = await supabase.from('bug_reports').insert({
        user_id, nome, phone, email, mensagem, tem_imagem: temImagem,
      }).select('id').single();
      id = row?.id || null;
    } catch (e) {
      console.warn('[/api/bug] insert falhou (segue pro WhatsApp):', e.message);
    }

    // 2) Encaminha pro WhatsApp de suporte.
    const cabecalho = [
      '🐞 *Novo relato de bug*',
      '',
      `👤 ${nome || '—'}${phone ? ` · ${phone}` : ''}`,
      email ? `✉️ ${email}` : null,
      `💳 plano: ${plano || '—'}`,
      id ? `🆔 ${id.slice(0, 8)}` : null,
      '',
      `📝 ${mensagem}`,
    ].filter(Boolean).join('\n');

    if (temImagem) {
      await enviarImagem(SUPORTE_PHONE, imagem, cabecalho);
    } else {
      await enviarTexto(SUPORTE_PHONE, cabecalho);
    }

    res.json({ ok: true, id });
  } catch (err) {
    console.error('[/api/bug] erro:', err);
    res.status(500).json({ erro: 'Não consegui enviar seu relato agora. Tente de novo em instantes.' });
  }
});

module.exports = router;
