// ── Dispatcher de provedor de WhatsApp ───────────────────────────────────────
// Ponto ÚNICO de troca Z-API ↔ Cloud API (Meta). Seleção por env:
//   WHATSAPP_PROVIDER=zapi  (padrão, atual em produção)
//   WHATSAPP_PROVIDER=meta  (Cloud API oficial)
//
// Fase 2 da migração: trocar os imports dos handlers de '../services/zapi'
// para '../services/mensageiro' — assim o flag passa a controlar tudo. Por ora
// nada importa daqui ainda; o Z-API segue como está.
const provider = (process.env.WHATSAPP_PROVIDER || 'zapi').toLowerCase();

module.exports = provider === 'meta'
  ? require('./whatsapp')
  : require('./zapi');
