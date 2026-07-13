// =====================================================================
// Webhook da Polp — chamado quando uma conexão atualiza (dados prontos/erro).
// Responde 200 rápido e sincroniza em background.
// ⚠️ Validação de assinatura (POLP_WEBHOOK_SECRET) e formato do payload/evento
// a confirmar na doc — ajustar quando as credenciais/docs chegarem.
// =====================================================================
const express  = require('express');
const router   = express.Router();
const polpSync = require('../services/polpSync');

router.post('/', async (req, res) => {
  // Responde já (a Polp espera 2xx rápido); a sincronização roda depois.
  res.json({ received: true });
  try {
    const evt = req.body || {};
    // ⚠️ nome do campo do id da conexão a confirmar
    const externalId = evt.integration_id || evt.id || (evt.data && evt.data.integration_id);
    if (externalId) {
      polpSync.sincronizarConexao(externalId).catch(e => console.warn('[webhook polp] sync:', e.message));
    }
  } catch (e) { console.warn('[webhook polp]', e.message); }
});

module.exports = router;
