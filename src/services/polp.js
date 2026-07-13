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

const BASE          = () => process.env.POLP_API_URL || 'https://api.polp.com.br'; // ⚠️ confirmar host
const API_KEY       = () => process.env.POLP_API_KEY;
const CLIENT_ID     = () => process.env.POLP_CLIENT_ID;
const CLIENT_SECRET = () => process.env.POLP_CLIENT_SECRET;

let _token = null;
let _tokenExp = 0; // epoch ms

function configurado() {
  return !!(API_KEY() || (CLIENT_ID() && CLIENT_SECRET()));
}

// Bearer atual: usa a API key direta OU troca client_id/secret por um token OAuth.
async function bearer() {
  if (API_KEY()) return API_KEY();
  if (!(CLIENT_ID() && CLIENT_SECRET())) {
    throw new Error('Polp não configurado (faltam POLP_API_KEY ou POLP_CLIENT_ID/SECRET).');
  }
  if (_token && Date.now() < _tokenExp) return _token;
  // ⚠️ Endpoint/payload de token a confirmar na doc (OAuth2 client_credentials).
  const r = await fetch(`${BASE()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: CLIENT_ID(), client_secret: CLIENT_SECRET() }),
  });
  if (!r.ok) throw new Error(`Polp /oauth/token falhou: ${r.status} ${await r.text()}`);
  const j = await r.json();
  _token = j.access_token || j.token;                 // ⚠️ nome do campo a confirmar
  _tokenExp = Date.now() + ((j.expires_in || 3000) * 1000) - 60_000; // renova com 1min de folga
  return _token;
}

// Chamada autenticada. `path` começa com "/".
async function api(path, { method = 'GET', body } = {}) {
  const tk = await bearer();
  const r = await fetch(`${BASE()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json' }, // ⚠️ header a confirmar (Bearer vs X-API-KEY)
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
