// ── Webhook da WhatsApp Cloud API (Meta) — FASE 1: teste ────────────────────
// Roda em paralelo ao /webhook (Z-API), sem afetá-lo. Por enquanto é um echo
// bot pra validar ponta-a-ponta no NÚMERO DE TESTE: confirma que a Meta entrega
// o inbound aqui, que conseguimos parsear o payload e responder via Cloud API.
// Na fase 2, plugamos o cérebro real da Sora (mesmo pipeline do webhook.js).
const express = require('express');
const axios   = require('axios');
const router  = express.Router();
const wa      = require('../services/whatsapp');
const { transcreverAudio } = require('../services/whisper');

const norm = (p) => (p ? String(p).replace(/\D/g, '') : p);

// Guarda a última entrada recebida + último status de entrega (memória) — só
// pra diagnóstico da migração.
let lastInbound = null;
let lastStatus = null;

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
    lastStatus,
    lastSendError: wa.getLastSendError ? wa.getLastSendError() : null,
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

  // &status=1 → pergunta à Meta o status real da WABA + do número (health_status
  // diz QUAL entidade bloqueia o envio e por quê — ex.: business locked).
  if (req.query.status) {
    const out = {};
    try {
      const w = await axios.get(`https://graph.facebook.com/${version}/${wabaId}?fields=id,name,account_review_status,health_status,country,owner_business_info`, auth);
      out.waba = w.data;
    } catch (e) { out.wabaError = e.response?.data || e.message; }
    try {
      const p = await axios.get(`https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}?fields=verified_name,display_phone_number,code_verification_status,quality_rating,name_status,status,platform_type,health_status`, auth);
      out.phone = p.data;
    } catch (e) { out.phoneError = e.response?.data || e.message; }
    return res.json({ env: { provider: env.provider, wabaId: env.wabaId, phoneNumberId: env.phoneNumberId }, status: out });
  }

  const to = norm(req.query.to);
  if (!to) return res.json({ env, subscribed, hint: '&subscribe=1 inscreve · &to=55DDD testa texto · &template=boas_vindas testa template · &status=1 status da conta' });

  const MSG = `https://graph.facebook.com/${version}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const headers = { ...auth.headers, 'Content-Type': 'application/json' };

  // Teste de TEMPLATE: &template=boas_vindas (param {{1}} = &p1 ou "Lenon").
  if (req.query.template) {
    const body = {
      messaging_product: 'whatsapp', to, type: 'template',
      template: {
        name: req.query.template,
        language: { code: req.query.lang || 'pt_BR' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: req.query.p1 || 'Lenon' }] }],
      },
    };
    try {
      const { data } = await axios.post(MSG, body, { headers });
      return res.json({ env, subscribed, templateSent: true, template: req.query.template, data });
    } catch (e) {
      return res.json({ env, subscribed, templateSent: false, template: req.query.template, status: e.response?.status, error: e.response?.data || e.message });
    }
  }

  try {
    const { data } = await axios.post(MSG, { messaging_product: 'whatsapp', to, type: 'text', text: { body: '🔧 Diagnóstico Sora — Cloud API funcionando ✅' } }, { headers });
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
  if (value.statuses) return { tipo: 'status', status: value.statuses[0] }; // entrega/falha
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
    if (!m) return;
    // Status de entrega (sent/delivered/read/failed) — guarda pra diagnóstico.
    if (m.tipo === 'status') {
      lastStatus = { ...m.status, em: new Date().toISOString() };
      if (m.status?.status === 'failed') console.warn('⚠️ [webhook-meta] FALHA de entrega:', JSON.stringify(m.status.errors || m.status));
      return;
    }
    if (!m.from) return;

    lastInbound = { ...m, em: new Date().toISOString() };
    console.log(`📩 [webhook-meta] ${m.tipo} de ${m.from}${m.nome ? ` (${m.nome})` : ''}: ${m.texto || m.raw || m.mediaId || ''}`);

    // Trava: só processa de verdade quando a Meta é o provedor ATIVO. Enquanto
    // WHATSAPP_PROVIDER=zapi, o /webhook/meta fica DORMENTE — não responde via
    // Z-API a quem chegou pela Meta. (lastInbound acima ainda alimenta o /diag.)
    if ((process.env.WHATSAPP_PROVIDER || 'zapi') !== 'meta') {
      console.log('💤 [webhook-meta] dormente (provedor ativo = zapi)');
      return;
    }

    // Cérebro real da Sora (mesmo pipeline do /webhook do Z-API). Envia via
    // mensageiro → como o flag é 'meta' aqui, sai pela Cloud API.
    const { processarMensagem } = require('./webhook');

    if (m.tipo === 'texto') {
      await processarMensagem({ phone: m.from, mensagem: m.texto, imageUrl: null, legendaImg: '' });

    } else if (m.tipo === 'audio') {
      // Mídia da Meta vem como ID → baixa com o token e passa o BUFFER ao Whisper.
      const mid = await wa.baixarMidia(m.mediaId);
      if (!mid) return wa.enviarTexto(m.from, '🎤 Não consegui baixar seu áudio. Tenta de novo?');
      let texto;
      try { texto = await transcreverAudio(mid.buffer, m.from); }
      catch { return wa.enviarTexto(m.from, '🎤 Não consegui entender o áudio. Pode repetir?'); }
      await processarMensagem({ phone: m.from, mensagem: texto, imageUrl: null, legendaImg: '' });

    } else if (m.tipo === 'imagem') {
      // Buffer → data URI (o OpenAI vision/OCR aceitam data URI no image_url).
      const mid = await wa.baixarMidia(m.mediaId);
      if (!mid) return wa.enviarTexto(m.from, '📷 Não consegui baixar sua imagem. Tenta de novo?');
      const imageUrl = `data:${mid.mime};base64,${mid.buffer.toString('base64')}`;
      const legendaImg = String(m.caption || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
      await processarMensagem({ phone: m.from, mensagem: '__imagem__', imageUrl, legendaImg });

    } else {
      await wa.enviarTexto(m.from, '🤖 Esse tipo de mensagem ainda não é suportado.');
    }
  } catch (e) {
    console.error('❌ [webhook-meta] erro:', e.message);
  }
});

module.exports = router;
