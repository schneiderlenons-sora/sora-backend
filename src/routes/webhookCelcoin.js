// =====================================================================
// Webhook do trilho CELCOIN (Polp v2).  POST /api/webhooks/celcoin
//
// Payload (doc /docs/celcoin/webhooks):
//   { event, resource, resource_id, query_parameters }
//
//   • evento de RECURSO      → resource = 'consents', resource_id = id do consent
//   • evento '*.transactions'→ resource = 'accounts' | 'credit-cards' | 'funds'…
//                              e resource_id = id DAQUELE recurso
//
// ⚠️ CONTRADIÇÃO NA DOC (registrada em docs/CELCOIN-API.md §3): a página
// /webhooks afirma que não existem mais `*.created` / `*.updated` / `*.sync` nem
// o campo `changes`, MAS o enum CelcoinWebhookEvent (página /enums) ainda lista
// `accounts.created`, `bills.sync`, etc. Então aqui:
//   1. o nome do evento é NORMALIZADO (tira .created/.updated/.deleted/.sync);
//   2. `changes` é ignorado — a fonte da verdade é sempre relistar;
//   3. evento desconhecido não é erro: sincroniza o consent e segue.
//
// A Celcoin dispara VÁRIOS eventos em sequência (accounts, accounts.transactions,
// credit_cards, bills…). Sem debounce, cada um dispararia um sync completo do
// consentimento — daí a janela de agrupamento abaixo.
// =====================================================================
const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const celcoinSync = require('../services/polpCelcoinSync');

const PROVIDER = 'polp-celcoin';

// ── Debounce por consentimento ──────────────────────────────────────────────
// Agrupa a rajada de eventos numa única sincronização.
const JANELA_MS = 20_000;
const agendados = new Map(); // consentId → timer

function agendarSync(consentId, motivo) {
  if (!consentId) return;
  const id = String(consentId);
  if (agendados.has(id)) return;               // já tem sync na fila pra esse consent
  const timer = setTimeout(async () => {
    agendados.delete(id);
    try {
      const r = await celcoinSync.sincronizarConsentimento(id, { dias: 90 });
      const resumo = r && r.erro ? `erro: ${r.erro}` : `${(r && r.novas) || 0} transação(ões) nova(s)`;
      console.log(`🔄 [celcoin] sync ${id} (${motivo}) → ${resumo}`);
    } catch (e) {
      console.warn(`[celcoin] sync ${id} falhou:`, e.message);
    }
  }, JANELA_MS);
  if (timer.unref) timer.unref();              // não segura o processo no shutdown
  agendados.set(id, timer);
}

/** Tira o sufixo de ciclo de vida do nome do evento (ver contradição acima). */
function eventoBase(event) {
  return String(event || '').trim().toLowerCase()
    .replace(/\.(created|updated|deleted|sync)$/, '');
}

/**
 * Descobre o consentimento a sincronizar.
 * - resource 'consents' → o próprio resource_id.
 * - '*.transactions'    → o resource_id é de uma conta/cartão/investimento. Não
 *   guardamos o consent por recurso, então achamos o GRUPO pela wallet (que tem
 *   of_conta_id) e sincronizamos as conexões Celcoin daquele grupo.
 */
async function consentsAlvo({ resource, resource_id }) {
  if (!resource_id) return [];
  const rec = String(resource || '').toLowerCase();
  if (!rec || rec === 'consents') return [String(resource_id)];

  // Recurso individual: chega na conexão pelo grupo da wallet correspondente.
  const { data: w } = await supabase.from('wallets')
    .select('grupo_id').eq('of_conta_id', String(resource_id)).limit(1).maybeSingle();
  if (w && w.grupo_id) {
    const { data: cx } = await supabase.from('of_conexoes')
      .select('external_id').eq('provider', PROVIDER).eq('grupo_id', w.grupo_id);
    if (cx && cx.length) return cx.map((c) => String(c.external_id));
  }
  // Investimento (não vira wallet) ou recurso ainda não importado: o evento de
  // recurso que acompanha a rajada já cobre. Não força sync às cegas.
  return [];
}

router.post('/', async (req, res) => {
  // A Polp espera 2xx rápido — responde já e trabalha depois.
  res.json({ received: true });

  try {
    const evt = req.body || {};
    const base = eventoBase(evt.event);
    const alvos = await consentsAlvo(evt);

    if (!alvos.length) {
      console.log(`📩 [celcoin] evento "${evt.event}" (${evt.resource}/${evt.resource_id}) sem consent conhecido — ignorado`);
      return;
    }
    for (const consentId of alvos) agendarSync(consentId, base || 'evento');
  } catch (e) {
    console.warn('[webhook celcoin]', e.message);
  }
});

module.exports = router;
module.exports.eventoBase = eventoBase;      // exposto pro eval
module.exports.consentsAlvo = consentsAlvo;
