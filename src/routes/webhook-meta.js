// ── Webhook da WhatsApp Cloud API (Meta) — FASE 1: teste ────────────────────
// Roda em paralelo ao /webhook (Z-API), sem afetá-lo. Por enquanto é um echo
// bot pra validar ponta-a-ponta no NÚMERO DE TESTE: confirma que a Meta entrega
// o inbound aqui, que conseguimos parsear o payload e responder via Cloud API.
// Na fase 2, plugamos o cérebro real da Sora (mesmo pipeline do webhook.js).
const express = require('express');
const router  = express.Router();
const wa      = require('../services/whatsapp');

const norm = (p) => (p ? String(p).replace(/\D/g, '') : p);

// ── GET: verificação do webhook (handshake da Meta) ──────────────────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('✅ [webhook-meta] verificado pela Meta');
    return res.status(200).send(challenge);
  }
  console.warn('⚠️ [webhook-meta] verify token inválido');
  return res.sendStatus(403);
});

// Extrai a primeira mensagem do payload aninhado da Meta.
function parseInbound(body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  if (!value) return null;
  if (value.statuses) return { tipo: 'status' };          // entregue/lido — ignorar
  const msg = value.messages?.[0];
  if (!msg) return null;
  const from = norm(msg.from);
  const nome = value.contacts?.[0]?.profile?.name || null;

  switch (msg.type) {
    case 'text':
      return { tipo: 'texto', from, nome, texto: msg.text?.body || '' };
    case 'interactive':
      return { tipo: 'texto', from, nome, texto: msg.interactive?.list_reply?.title || msg.interactive?.button_reply?.title || '' };
    case 'button':
      return { tipo: 'texto', from, nome, texto: msg.button?.text || '' };
    case 'audio':
      return { tipo: 'audio', from, nome, mediaId: msg.audio?.id || null };
    case 'image':
      return { tipo: 'imagem', from, nome, mediaId: msg.image?.id || null, caption: msg.image?.caption || '' };
    default:
      return { tipo: 'outro', from, nome, raw: msg.type };
  }
}

// ── POST: recebe mensagens ───────────────────────────────────────────────────
router.post('/', async (req, res) => {
  res.sendStatus(200); // ACK imediato (a Meta reenvia se não receber 200 rápido)
  try {
    const m = parseInbound(req.body);
    if (!m || m.tipo === 'status' || !m.from) return;

    console.log(`📩 [webhook-meta] ${m.tipo} de ${m.from}${m.nome ? ` (${m.nome})` : ''}: ${m.texto || m.raw || m.mediaId || ''}`);

    if (m.tipo === 'texto') {
      await wa.enviarTexto(m.from, `🤖 *Sora (Cloud API)* recebeu: "${m.texto}"\n\nMigração em teste ✅`);
    } else if (m.tipo === 'audio' || m.tipo === 'imagem') {
      const mid = await wa.baixarMidia(m.mediaId);
      await wa.enviarTexto(m.from, `🤖 Recebi seu ${m.tipo} via Cloud API (${mid ? `${(mid.buffer.length / 1024).toFixed(0)} KB, ${mid.mime}` : 'download falhou'}).`);
    } else {
      await wa.enviarTexto(m.from, `🤖 Recebi um conteúdo do tipo "${m.raw}" (ainda não tratado no teste).`);
    }
  } catch (e) {
    console.error('❌ [webhook-meta] erro:', e.message);
  }
});

module.exports = router;
