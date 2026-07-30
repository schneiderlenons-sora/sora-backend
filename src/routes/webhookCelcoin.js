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
const crypto   = require('crypto');
const router   = express.Router();
const supabase = require('../db/supabase');
const celcoinSync = require('../services/polpCelcoinSync');

const PROVIDER = 'polp-celcoin';

// ── Assinatura HMAC-SHA256 (opção "Assinatura HMAC" no dashboard da Polp) ────
// A Polp manda o header `X-Webhook-Signature` calculado sobre o corpo CRU.
//
// Enquanto POLP_CELCOIN_WEBHOOK_SECRET não estiver definido, o webhook aceita
// tudo (é como estava antes) — assim ligar a env e ligar a chave no dashboard
// podem acontecer em ordens diferentes sem derrubar a integração. Com a env
// definida, assinatura ausente/errada vira 401.
//
// O formato exato do header não está na doc pública, então comparamos contra as
// codificações usuais (hex e base64, com ou sem prefixo `sha256=`). O primeiro
// payload rejeitado loga o que veio, pra ajustar em segundos se for outro.
const SEGREDO = () => process.env.POLP_CELCOIN_WEBHOOK_SECRET || '';

function assinaturaConfere(rawBody, header) {
  const segredo = SEGREDO();
  if (!segredo) return true;                       // validação desligada
  if (!header || !rawBody) return false;

  const recebida = String(header).trim().replace(/^sha256=/i, '');
  const mac = crypto.createHmac('sha256', segredo).update(rawBody);
  const digest = mac.digest();
  const candidatos = [digest.toString('hex'), digest.toString('base64')];

  return candidatos.some((esperada) => {
    if (esperada.length !== recebida.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(recebida));
    } catch { return false; }
  });
}

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

  const id = String(resource_id);

  // Recurso individual (conta, cartão ou investimento): não guardamos o consent
  // por recurso, então chegamos nele pelo GRUPO do registro já importado.
  // Conta/cartão viram wallet (of_conta_id); investimento vira linha em
  // `investimentos` (of_id).
  const achaGrupo = async () => {
    const { data: w } = await supabase.from('wallets')
      .select('grupo_id').eq('of_conta_id', id).limit(1).maybeSingle();
    if (w && w.grupo_id) return w.grupo_id;
    try {
      const { data: i } = await supabase.from('investimentos')
        .select('grupo_id').eq('of_id', id).limit(1).maybeSingle();
      if (i && i.grupo_id) return i.grupo_id;
    } catch { /* coluna of_id ausente → ignora */ }
    return null;
  };

  const grupoId = await achaGrupo();
  if (grupoId) {
    const { data: cx } = await supabase.from('of_conexoes')
      .select('external_id').eq('provider', PROVIDER).eq('grupo_id', grupoId);
    if (cx && cx.length) return cx.map((c) => String(c.external_id));
  }
  // Recurso ainda não importado (1ª sincronização): o evento de RECURSO que vem
  // na mesma rajada já cobre. Não força sync às cegas.
  return [];
}

router.post('/', async (req, res) => {
  // Assinatura primeiro: com o segredo configurado, payload não assinado (ou
  // assinado errado) não pode disparar sincronização.
  if (SEGREDO() && !assinaturaConfere(req.rawBody, req.get('x-webhook-signature'))) {
    const recebido = req.get('x-webhook-signature');
    console.warn('[webhook celcoin] assinatura inválida — header recebido:',
      recebido ? `${String(recebido).slice(0, 24)}… (${String(recebido).length} chars)` : '(ausente)');
    return res.status(401).json({ erro: 'assinatura inválida' });
  }

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
module.exports.eventoBase = eventoBase;              // expostos pro eval/diagnóstico
module.exports.consentsAlvo = consentsAlvo;
module.exports.assinaturaConfere = assinaturaConfere;
