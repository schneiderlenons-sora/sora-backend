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

// Template de RESPOSTA AO RELATO: `comunicado_sora` — corpo:
//   "Oi, {{1}}! ... sobre o que você nos enviou: {{2}}. ..."
//   {{1}} = nome do cliente · {{2}} = a resposta do admin.
// ⚠️ Precisa estar APROVADO na Meta; enquanto "em análise", o envio falha.
// Header de imagem: COMUNICADO_CAPA_URL (a capa "Comunicado Sora") — cai na
// capa genérica da Sora se não setar.
const TEMPLATE_RESPOSTA = 'comunicado_sora';
const CAPA_COMUNICADO = () => process.env.COMUNICADO_CAPA_URL || CAPA();

// POST /api/admin/responder-relato  { phone, nome, texto }
router.post('/responder-relato', async (req, res) => {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ erro: 'ADMIN_SECRET não configurado no servidor.' });
  if (req.headers['x-admin-secret'] !== secret) return res.status(403).json({ erro: 'nao_autorizado' });

  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  const texto = String(req.body?.texto || '').trim();
  if (!phone || !texto) return res.status(400).json({ erro: 'phone e texto são obrigatórios' });
  // {{1}} = primeiro nome (fallback amigável pra não sair "Oi, !").
  const nome = (oneLine(req.body?.nome || '').split(' ')[0] || 'tudo bem').slice(0, 60);

  const antes = Date.now();
  // Com WHATSAPP_PROVIDER=meta vai o TEMPLATE (entrega dentro E fora das 24h).
  await enviarProativo(phone, {
    texto, // fallback (Z-API / dentro da janela)
    template: { name: TEMPLATE_RESPOSTA, params: [nome, oneLine(texto)], opts: { headerImage: CAPA_COMUNICADO() } },
  });

  const err = getLastSendError();
  if (err && new Date(err.em).getTime() >= antes) {
    return res.json({ ok: false, code: err.code, erro: err.message });
  }
  res.json({ ok: true });
});

module.exports = router;
