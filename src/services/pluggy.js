// =====================================================================
// Cliente da API do Pluggy (Open Finance).
// Fluxo: clientId+clientSecret → POST /auth → apiKey (válida ~2h, cacheada).
// A apiKey vai no header X-API-KEY de toda chamada da Data API.
// O connectToken (curto, ~30min) é gerado pro widget Pluggy Connect no front.
// Docs: https://docs.pluggy.ai
// =====================================================================
const BASE = 'https://api.pluggy.ai';

const CLIENT_ID     = process.env.PLUGGY_CLIENT_ID;
const CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET;

let _apiKey = null;
let _apiKeyExp = 0; // epoch ms

function configurado() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

// Obtém (e cacheia) a apiKey. A apiKey dura ~2h; renovamos com folga (110min).
async function getApiKey() {
  if (!configurado()) throw new Error('Pluggy não configurado (faltam PLUGGY_CLIENT_ID / PLUGGY_CLIENT_SECRET).');
  if (_apiKey && Date.now() < _apiKeyExp) return _apiKey;

  const r = await fetch(`${BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
  });
  if (!r.ok) throw new Error(`Pluggy /auth falhou: ${r.status} ${await r.text()}`);
  const j = await r.json();
  _apiKey = j.apiKey;
  _apiKeyExp = Date.now() + 110 * 60 * 1000;
  return _apiKey;
}

// Chamada autenticada na Data API. `path` começa com "/".
async function api(path, { method = 'GET', body } = {}) {
  const apiKey = await getApiKey();
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Pluggy ${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json();
}

// Connect token pro widget no front. itemId opcional = modo "atualizar conexão".
async function criarConnectToken(itemId) {
  const j = await api('/connect_token', { method: 'POST', body: itemId ? { itemId } : {} });
  return j.accessToken;
}

async function getItem(itemId) {
  return api(`/items/${itemId}`);
}

async function listarContas(itemId) {
  const j = await api(`/accounts?itemId=${encodeURIComponent(itemId)}`);
  return j.results || [];
}

// Transações de uma conta a partir de `from` (YYYY-MM-DD). Pagina até o fim.
async function listarTransacoes(accountId, from) {
  const out = [];
  let page = 1;
  for (;;) {
    const qs = new URLSearchParams({ accountId, pageSize: '500', page: String(page) });
    if (from) qs.set('from', from);
    const j = await api(`/transactions?${qs.toString()}`);
    const res = j.results || [];
    out.push(...res);
    if (res.length < 500 || page >= (j.totalPages || 1)) break;
    page++;
  }
  return out;
}

// Apaga o item no Pluggy (ao desconectar). Tolerante a falha.
async function apagarItem(itemId) {
  try { await api(`/items/${itemId}`, { method: 'DELETE' }); } catch (e) { /* segue */ }
}

module.exports = {
  configurado, criarConnectToken, getItem, listarContas, listarTransacoes, apagarItem,
};
