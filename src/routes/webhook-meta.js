// ── Webhook da WhatsApp Cloud API (Meta) — FASE 1: teste ────────────────────
// Roda em paralelo ao /webhook (Z-API), sem afetá-lo. Por enquanto é um echo
// bot pra validar ponta-a-ponta no NÚMERO DE TESTE: confirma que a Meta entrega
// o inbound aqui, que conseguimos parsear o payload e responder via Cloud API.
// Na fase 2, plugamos o cérebro real da Sora (mesmo pipeline do webhook.js).
const express = require('express');
const axios   = require('axios');
const router  = express.Router();
const wa      = require('../services/whatsapp');

const norm = (p) => (p ? String(p).replace(/\D/g, '') : p);

// Guarda a última entrada recebida (memória) — só pra diagnóstico da migração.
let lastInbound = null;

// ── GET /diag: diagnóstico (isola token x assinatura x inbound) ───────────────
// Uso: /webhook/meta/diag?key=<verify_token>[&to=55DDD][&subscribe=1]
//  - sem nada    → config + lastInbound + status de assinatura do WABA no app
//  - &subscribe=1→ INSCREVE o app na WABA (POST subscribed_apps) — fix do inbound
//  - &to=55...   → tenta ENVIAR direto e devolve o erro cru da Meta
router.get('/diag', async (req, res) => {
  if (req.query.key !== process.env.WHATSAPP_VERIFY_TOKEN) return res.sendStatus(403);
  const version = process.env.WHATSAPP_API_VERSION || 'v21.0';
  const TOKEN   = process.env.WHATSAPP_TOKEN;
  const wabaId  = process.env.WHATSAPP_WABA_ID;
  const auth    = { headers: { Authorization: `Bearer ${TOKEN}` } };
  const env = {
    provider: process.env.WHATSAPP_PROVIDER || 'zapi',
    hasToken: !!TOKEN,
    tokenLen: (TOKEN || '').length,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || null,
    wabaId: wabaId || null,
    version,
    lastInbound,
  };

  // Assinatura do WABA ↔ app (é o que faz a Meta ENTREGAR o inbound).
  let subscribed = null;
  if (wabaId) {
    try {
      if (req.query.subscribe === '1') {
        const r = await axios.post(`https://graph.facebook.com/${version}/${wabaId}/subscribed_apps`, {}, auth);
        subscribed = { acaoInscrever: r.data };
      } else {
        const r = await axios.get(`https://graph.facebook.com/${version}/${wabaId}/subscribed_apps`, auth);
        subscribed = r.data;
      }
    } catch (e) {
      subscribed = { error: e.response?.data || e.message };
    }
  }

  const to = norm(req.query.to);
  if (!to) return res.json({ env, subscribed, hint: '&subscribe=1 inscreve o app no WABA · &to=55DDD testa o envio' });
  try {
    const { data } = await axios.post(
      `https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: '🔧 Diagnóstico Sora — Cloud API funcionando ✅' } },
      { headers: { ...auth.headers, 'Content-Type': 'application/json' } },
    );
    return res.json({ env, subscribed, sent: true, data });
  } catch (e) {
    return res.json({ env, subscribed, sent: false, status: e.response?.status, error: e.response?.data || e.message });
  }
});

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

    lastInbound = { ...m, em: new Date().toISOString() };
    console.log(`📩 [webhook-meta] ${m.tipo} de ${m.from}${m.nome ? ` (${m.nome})` : ''}: ${m.texto || m.raw || m.mediaId || ''}`);

    // Trava: só processa de verdade quando a Meta é o provedor ATIVO. Enquanto
    // WHATSAPP_PROVIDER=zapi, o /webhook/meta fica DORMENTE — não responde via
    // Z-API a quem chegou pela Meta. (lastInbound acima ainda alimenta o /diag.)
    if ((process.env.WHATSAPP_PROVIDER || 'zapi') !== 'meta') {
      console.log('💤 [webhook-meta] dormente (provedor ativo = zapi)');
      return;
    }

    if (m.tipo === 'texto') {
      // Cérebro real da Sora (mesmo pipeline do /webhook do Z-API). Envia via
      // mensageiro → como o flag é 'meta' aqui, sai pela Cloud API.
      const { processarMensagem } = require('./webhook');
      await processarMensagem({ phone: m.from, mensagem: m.texto, imageUrl: null, legendaImg: '' });
    } else if (m.tipo === 'audio' || m.tipo === 'imagem') {
      // TODO fase 2.2: baixarMidia(m.mediaId) → buffer → Whisper/OCR (hoje
      // esperam URL pública). Por ora, pede texto.
      await wa.enviarTexto(m.from, `🚧 Recebi seu ${m.tipo}, mas o processamento de mídia pela Cloud API ainda está sendo migrado. Por enquanto, manda por texto. 🙏`);
    } else {
      await wa.enviarTexto(m.from, '🤖 Esse tipo de mensagem ainda não é suportado.');
    }
  } catch (e) {
    console.error('❌ [webhook-meta] erro:', e.message);
  }
});

module.exports = router;
