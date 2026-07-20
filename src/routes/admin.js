// ─────────────────────────────────────────────────────────────────
// Admin (server-to-server) — chamado SÓ pelo painel admin do Next.js (que já
// valida checkAdmin). Autenticado por SECRET interno (x-admin-secret) porque o
// auth normal amarra o request ao telefone do próprio usuário (anti-IDOR).
//
// Env: ADMIN_SECRET (mesmo valor no Render e na Vercel).
// ─────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const { enviarProativo } = require('../services/proativo');
const { getLastSendError } = require('../services/whatsapp');

const oneLine = (s) => String(s || '').replace(/\s*[\r\n\t]+\s*/g, ' ').trim();
const CAPA = () => process.env.SORA_CAPA_URL
  || `${(process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://www.forsora.com').replace(/\/$/, '')}/sora-capa.png`;

// Template usado pra RESPONDER RELATO. Reusa o `lembretes_gerais` (já aprovado,
// corpo 100% variável {{1}}) → alcança FORA da janela de 24h sem template novo.
// Pra trocar por um dedicado (ex.: 'resposta_relato'), muda só o name aqui.
const TEMPLATE_RESPOSTA = 'lembretes_gerais';

// POST /api/admin/responder-relato  { phone, texto }
router.post('/responder-relato', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ erro: 'ADMIN_SECRET não configurado no servidor.' });
  if (req.headers['x-admin-secret'] !== secret) return res.status(403).json({ erro: 'nao_autorizado' });

  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  const texto = String(req.body?.texto || '').trim();
  if (!phone || !texto) return res.status(400).json({ erro: 'phone e texto são obrigatórios' });

  const antes = Date.now();
  // Com WHATSAPP_PROVIDER=meta vai o TEMPLATE (entrega dentro E fora das 24h).
  await enviarProativo(phone, {
    texto, // fallback (Z-API / dentro da janela)
    template: { name: TEMPLATE_RESPOSTA, params: [oneLine(texto)], opts: { headerImage: CAPA() } },
  });

  const err = getLastSendError();
  if (err && new Date(err.em).getTime() >= antes) {
    return res.json({ ok: false, code: err.code, erro: err.message });
  }
  res.json({ ok: true });
});

module.exports = router;
