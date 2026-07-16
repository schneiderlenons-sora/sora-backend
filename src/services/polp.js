// =====================================================================
// Cliente da API da Polp (Open Finance) — ESQUELETO.
// Espelha a estrutura do services/pluggy.js. Os PATHS e NOMES DE CAMPOS abaixo
// são a melhor aposta a partir do material público da Polp (POST /integrations,
// contas/transações/saldos, SDK). ⚠️ CONFIRMAR TUDO NA DOC/SWAGGER OFICIAL antes
// de ligar em produção — troque só os pontos marcados "⚠️".
//
// Auth: suporta API key direta (POLP_API_KEY) OU client credentials
// (POLP_CLIENT_ID + POLP_CLIENT_SECRET → OAuth2 client_credentials). Tudo lido
// em runtime (não no boot) pra não derrubar o app quando ainda não configurado.
// =====================================================================

// Base confirmada na doc: https://api.polp.com.br/api/v1
const BASE          = () => process.env.POLP_API_URL || 'https://api.polp.com.br/api/v1';
const CLIENT_ID     = () => process.env.POLP_CLIENT_ID;
const CLIENT_SECRET = () => process.env.POLP_CLIENT_SECRET;

function configurado() {
  return !!(CLIENT_ID() && CLIENT_SECRET());
}

// Auth da Polp (doc "Authentication"): NÃO tem /auth nem token — as credenciais
// vão em DOIS headers em toda requisição.
//   x-api-client = client_id (público)   ·   x-api-secret = client_secret
async function api(path, { method = 'GET', body } = {}) {
  if (!configurado()) throw new Error('Polp não configurado (faltam POLP_CLIENT_ID / POLP_CLIENT_SECRET).');
  const r = await fetch(`${BASE()}${path}`, {
    method,
    headers: {
      'x-api-client': CLIENT_ID(),
      'x-api-secret': CLIENT_SECRET(),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Polp ${method} ${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? {} : r.json();
}

// ── Conexão (o "item"/consentimento) ────────────────────────────────────────
// Inicia uma integração → devolve o id da conexão + a URL do Polp Link pro user
// autorizar o banco. `payload` mínimo: conector/instituição + dados básicos.
// ⚠️ path (POST /integrations) e formato da resposta a confirmar.
async function iniciarConexao({ connector, redirectUrl, webhookUrl, externalUserId } = {}) {
  const j = await api('/integrations', {
    method: 'POST',
    body: { connector, redirect_url: redirectUrl, webhook_url: webhookUrl, external_user_id: externalUserId },
  });
  // ⚠️ nomes a confirmar (id / redirect_url / connect_url)
  return { externalId: j.id || j.integration_id, linkUrl: j.redirect_url || j.connect_url || j.url };
}

async function getConexao(id)        { return api(`/integrations/${encodeURIComponent(id)}`); }        // ⚠️
async function listarContas(id)      { return listaDe(await api(`/integrations/${id}/accounts`)); }     // ⚠️
async function listarCartoes(id)     { return listaDe(await api(`/integrations/${id}/cards`)); }        // ⚠️
async function listarCaixinhas(id)   { return listaDe(await api(`/integrations/${id}/pockets`)); }      // ⚠️ (caixinhas/objetivos)
async function listarInvestimentos(id){ return listaDe(await api(`/integrations/${id}/investments`)); } // ⚠️

// Transações de uma conta a partir de `dateFrom` (YYYY-MM-DD). ⚠️ path/params +
// paginação (cursor?) a confirmar; por ora tenta paginação simples por `page`.
async function listarTransacoes(contaId, dateFrom) {
  const out = [];
  for (let page = 1; page <= 200; page++) {
    const qs = new URLSearchParams({ account_id: contaId, page: String(page) });
    if (dateFrom) qs.set('date_from', dateFrom);
    const j = await api(`/transactions?${qs.toString()}`);
    const results = listaDe(j);
    out.push(...results);
    if (results.length === 0 || !j.next) break; // ⚠️ critério de fim a confirmar
  }
  return out;
}

async function removerConexao(id) {
  try { await api(`/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { /* tolerante */ }
}

// A API pode devolver { results: [] } ou { data: [] } ou o array cru.
function listaDe(j) {
  if (Array.isArray(j)) return j;
  return j?.results || j?.data || j?.items || [];
}

module.exports = {
  configurado, iniciarConexao, getConexao,
  listarContas, listarCartoes, listarCaixinhas, listarInvestimentos, listarTransacoes,
  removerConexao,
};
