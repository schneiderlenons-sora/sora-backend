// =====================================================================
// Cliente da API do Pluggy (Open Finance).
// Fluxo: clientId+clientSecret → POST /auth → apiKey (válida ~2h, cacheada).
// A apiKey vai no header X-API-KEY de toda chamada da Data API.
// O connectToken (curto, ~30min) é gerado pro widget Pluggy Connect no front.
// Docs: https://docs.pluggy.ai
// =====================================================================
// A Polp REVENDE a Pluggy (docs em polp.com.br/docs/pluggy). Então aceitamos as
// credenciais com o prefixo POLP_ (o que está no Render) OU PLUGGY_. E a base é
// configurável: se a Polp usar um host próprio (proxy), é só setar POLP_API_URL —
// senão vai direto na Pluggy.
const BASE          = process.env.POLP_API_URL     || process.env.PLUGGY_API_URL     || 'https://api.pluggy.ai';
const CLIENT_ID     = process.env.POLP_CLIENT_ID     || process.env.PLUGGY_CLIENT_ID;
const CLIENT_SECRET = process.env.POLP_CLIENT_SECRET || process.env.PLUGGY_CLIENT_SECRET;

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

// Transações de uma conta a partir de `dateFrom` (YYYY-MM-DD).
// Usa GET /v2/transactions com paginação por CURSOR — o /transactions antigo
// (paginação por página) foi descontinuado (410). O v2 NÃO aceita `pageSize`
// nem `from`: usa `dateFrom` e o cursor `after` (extraído da URL `next`).
// Resposta: { results, next }; segue até next == null.
async function listarTransacoes(accountId, dateFrom) {
  const out = [];
  let after = null;
  for (let i = 0; i < 200; i++) { // teto de segurança (200 páginas)
    const qs = new URLSearchParams({ accountId });
    if (dateFrom) qs.set('dateFrom', dateFrom);
    if (after) qs.set('after', after);
    const j = await api(`/v2/transactions?${qs.toString()}`);
    out.push(...(j.results || []));
    if (!j.next) break;
    try { after = new URL(j.next, BASE).searchParams.get('after'); }
    catch { after = null; }
    if (!after) break;
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
