/**
 * Importação histórica Hotmart — puxa vendas dos últimos 90 dias via API REST.
 * Documentação: https://developers.hotmart.com/payments/api/v1/sales/history
 *
 * Chamado após conectar a integração pela primeira vez.
 * Idempotente via unique(integracao_id, ref_externa) — pode rodar N vezes.
 */
const { ingerirEvento } = require('../handlers/negocios');

const HOTMART_BASE = 'https://developers.hotmart.com';
const PAGE_SIZE    = 500;

/**
 * Busca token OAuth Hotmart usando Client Credentials.
 * credenciais esperadas: { client_id, client_secret, basic } ou { token } (legado).
 */
async function getAccessToken(credenciais) {
  // Se já veio um bearer token direto (modo simples), usa ele
  if (credenciais.token && !credenciais.client_id) {
    return credenciais.token;
  }

  // OAuth Client Credentials
  const basic = credenciais.basic ||
    Buffer.from(`${credenciais.client_id}:${credenciais.client_secret}`).toString('base64');

  const res = await fetch('https://api-sec-vlc.hotmart.com/security/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${basic}`,
    },
    body: JSON.stringify({ grant_type: 'client_credentials' }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Hotmart OAuth falhou (${res.status}): ${err.slice(0, 200)}`);
  }
  const { access_token } = await res.json();
  return access_token;
}

/**
 * Faz uma página da API de histórico de vendas.
 */
async function fetchPagina(token, startDate, endDate, pageToken = null) {
  const params = new URLSearchParams({
    max_results: String(PAGE_SIZE),
    start_date:  String(startDate),
    end_date:    String(endDate),
  });
  if (pageToken) params.set('page_token', pageToken);

  const res = await fetch(
    `${HOTMART_BASE}/payments/api/v1/sales/history?${params}`,
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Hotmart API falhou (${res.status}): ${err.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Importa histórico dos últimos `diasAtras` dias para a integração.
 * Retorna { importados, ignorados, erros }.
 */
async function importarHistoricoHotmart(integ, diasAtras = 90) {
  const credenciais = integ.credenciais || {};
  const token = await getAccessToken(credenciais);

  const endDate   = Date.now();
  const startDate = endDate - diasAtras * 24 * 60 * 60 * 1000;

  let importados = 0, ignorados = 0, erros = 0;
  let pageToken  = null;
  let pagina     = 0;

  do {
    pagina++;
    console.log(`[hotmart-import] página ${pagina}...`);

    let resposta;
    try {
      resposta = await fetchPagina(token, startDate, endDate, pageToken);
    } catch (e) {
      console.error('[hotmart-import] erro ao buscar página:', e.message);
      break;
    }

    const items = resposta?.items || [];
    console.log(`[hotmart-import] ${items.length} itens nesta página.`);

    for (const item of items) {
      // A API de histórico retorna shape ligeiramente diferente do webhook —
      // normalizamos pra um envelope compatível com normalizarHotmart()
      const payload = adaptarHistoricoParaWebhook(item);
      if (!payload) { ignorados++; continue; }

      try {
        const r = await ingerirEvento(integ, payload);
        if (r.ignorado) ignorados++;
        else importados++;
      } catch (e) {
        // unique constraint = já existia — não é erro real
        if (e.code === '23505' || e.message?.includes('unique')) ignorados++;
        else { erros++; console.error('[hotmart-import] ingerirEvento erro:', e.message); }
      }
    }

    pageToken = resposta?.page_info?.next_page_token || null;
  } while (pageToken);

  console.log(`[hotmart-import] concluído — importados:${importados} ignorados:${ignorados} erros:${erros}`);
  return { importados, ignorados, erros };
}

/**
 * Adapta o shape da API de histórico pro formato de webhook esperado pelo adapter.
 * API histórico: { purchase: { transaction, status, ... }, product, buyer, ... }
 */
function adaptarHistoricoParaWebhook(item) {
  const status = item?.purchase?.status;
  if (!status) return null;

  // Mapeia status → event (mesmo mapeamento do webhook)
  const STATUS_EVENTO = {
    APPROVED:   'PURCHASE_APPROVED',
    COMPLETE:   'PURCHASE_COMPLETE',
    REFUNDED:   'PURCHASE_REFUNDED',
    CHARGEBACK: 'PURCHASE_CHARGEBACK',
    CANCELLED:  'SUBSCRIPTION_CANCELLATION',
    ACTIVE:     'PURCHASE_APPROVED',
    DELAYED:    null,
    PRINTED_BILLET: null,
    WAITING_PAYMENT: null,
    UNDER_ANALISYS: null,
    EXPIRED: null,
  };

  const event = STATUS_EVENTO[status];
  if (!event) return null;

  return {
    event,
    data: {
      purchase: item.purchase,
      product:  item.product,
      buyer:    item.buyer,
      affiliates: item.affiliates || [],
      commissions: item.commissions || [],
      subscription: item.subscription || null,
    },
  };
}

module.exports = { importarHistoricoHotmart };
