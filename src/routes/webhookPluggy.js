// =====================================================================
// Webhook do Pluggy — POST /api/webhooks/pluggy
// Responde 2XX em <5s (exigência do Pluggy) e processa em background.
// Eventos: item/created, item/updated → sincroniza; item/error → marca erro.
// SEM auth (quem chama é o Pluggy). Tolerante a payload de teste do dashboard.
// =====================================================================
const express = require('express');
const router  = express.Router();
const pluggySync = require('../services/pluggySync');

async function processar(body) {
  const event  = body?.event;
  const itemId = body?.itemId || body?.item?.id;
  if (!itemId) return; // ping de teste do dashboard não tem itemId — ok

  if (event === 'item/created' || event === 'item/updated') {
    await pluggySync.sincronizarItem(itemId);
  } else if (event === 'item/error' || event === 'item/login_error') {
    await pluggySync.marcarErro(itemId, body?.error || body?.data || 'erro na conexão');
  }
}

router.post('/', (req, res) => {
  // Responde já — o processamento não pode segurar a resposta.
  res.status(200).json({ received: true });
  Promise.resolve(processar(req.body)).catch(e => console.warn('[pluggy webhook]', e.message));
});

module.exports = router;
