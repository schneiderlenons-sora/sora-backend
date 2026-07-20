// ─────────────────────────────────────────────────────────────────
// Admin (server-to-server) — chamado SÓ pelo painel admin do Next.js, que já
// valida checkAdmin. Autenticado por SECRET interno (x-admin-secret) porque o
// auth normal amarra o request ao telefone do próprio usuário (anti-IDOR) e
// aqui a gente precisa mandar pro telefone de OUTRA pessoa.
//
// Env: ADMIN_SECRET (mesmo valor no Render e na Vercel). Sem ele → 503.
// ─────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const { enviarTexto, getLastSendError } = require('../services/whatsapp');

// POST /api/admin/enviar-whatsapp  { phone, texto }
router.post('/enviar-whatsapp', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ erro: 'ADMIN_SECRET não configurado no servidor.' });
  if (req.headers['x-admin-secret'] !== secret) return res.status(403).json({ erro: 'nao_autorizado' });

  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  const texto = String(req.body?.texto || '').trim();
  if (!phone || !texto) return res.status(400).json({ erro: 'phone e texto são obrigatórios' });

  const antes = Date.now();
  await enviarTexto(phone, texto);

  // enviarTexto engole o erro; getLastSendError diz se ESTE envio falhou.
  const err = getLastSendError();
  if (err && new Date(err.em).getTime() >= antes) {
    // 131047/131051 = janela de 24h fechada → só template alcança.
    const foraDaJanela = err.code === 131047 || err.code === 131051 || /re-?engag|24 ?h|outside the allowed window/i.test(err.message || '');
    return res.json({ ok: false, foraDaJanela, code: err.code, erro: err.message });
  }
  res.json({ ok: true });
});

module.exports = router;
