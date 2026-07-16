// =====================================================================
// Cliente da API da Polp (Open Finance — proxy da Pluggy).
// Base: https://api.polp.com.br/api/v1  ·  Docs: polp.com.br/docs/pluggy
//
// Auth (doc "Authentication"): SEM /auth e SEM token — as credenciais vão em
// DOIS headers em toda requisição:
//   x-api-client = client_id (público)   ·   x-api-secret = client_secret
//
// Fluxo de conexão (doc "Create Integration"): POST /integrations cria a
// integração (assíncrona) e, se a instituição exigir login do usuário, devolve
// `url_to_authenticate` — o link que o usuário abre pra autorizar o banco. O
// status caminha UPDATING → WAITING_USER_INPUT → UPDATED (avisado por webhook).
// =====================================================================

const BASE          = () => process.env.POLP_API_URL || 'https://api.polp.com.br/api/v1';
const CLIENT_ID     = () => process.env.POLP_CLIENT_ID;
const CLIENT_SECRET = () => process.env.POLP_CLIENT_SECRET;

function configurado() {
  return !!(CLIENT_ID() && CLIENT_SECRET());
}

// Chamada autenticada. `path` começa com "/".
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

// As respostas vêm em { data: ... , links, meta }.
const dados = (j) => (j && j.data !== undefined ? j.data : j);

// ── Instituições (pro seletor de banco) ──────────────────────────────────────
async function listarInstituicoes() {
  try { return dados(await api('/institutions')) || []; } catch { return []; }
}

// ── Criar integração (o "conectar banco") ────────────────────────────────────
// products: pede TUDO que a Sora usa (contas, cartões, transações, investimentos,
// dívidas) — é o que faltava antes (investimentos não vinham).
const PRODUTOS = ['ACCOUNTS', 'CREDIT_CARDS', 'TRANSACTIONS', 'INVESTMENTS', 'LOANS'];
async function criarIntegracao({ institutionId, cpf, cnpj } = {}) {
  const body = { institution_id: Number(institutionId), products: PRODUTOS };
  if (cpf)  body.cpf  = String(cpf).replace(/\D/g, '');
  if (cnpj) body.cnpj = String(cnpj).replace(/\D/g, '');
  const d = dados(await api('/integrations', { method: 'POST', body }));
  return { id: d.id, status: d.status, urlToAuthenticate: d.url_to_authenticate || null };
}

async function getIntegracao(id) {
  return dados(await api(`/integrations/${encodeURIComponent(id)}`));
}

// Contas + cartões da integração (mesmo endpoint; `type` BANK|CREDIT distingue).
async function listarContas(id) {
  return dados(await api(`/integrations/${encodeURIComponent(id)}/accounts`)) || [];
}

// Investimentos da integração (tolerante — nem toda instituição expõe).
async function listarInvestimentos(id) {
  try { return dados(await api(`/integrations/${encodeURIComponent(id)}/investments`)) || []; }
  catch { return []; }
}

// Transações de UMA conta. GET /accounts/{id}/transactions — ordenado por data
// DESC, paginado 50/página (meta.last_page). `dateFrom` (YYYY-MM-DD) corta a
// busca cedo (para de paginar ao passar do corte, já que vem do mais recente).
async function listarTransacoes(accountId, dateFrom, { paginaMax = 300 } = {}) {
  const out = [];
  for (let page = 1; page <= paginaMax; page++) {
    const j = await api(`/accounts/${encodeURIComponent(accountId)}/transactions?page=${page}`);
    const results = j?.data || [];
    out.push(...results);
    const ultima = results[results.length - 1];
    if (dateFrom && ultima && String(ultima.date) < dateFrom) break;   // já passou do corte
    const last = j?.meta?.last_page;
    if (!results.length || (last && page >= last)) break;
  }
  return dateFrom ? out.filter(t => String(t.date) >= dateFrom) : out;
}

// Faturas de UM cartão. A fatura REAL vem pronta aqui (valor + vencimento) —
// é a fonte certa: `balance` da conta é a dívida corrente (inclui compras já do
// próximo ciclo) e o MP não manda `balanceCloseDate`, então não dá pra recortar
// o ciclo por conta própria. Tolerante: nem toda instituição/plano expõe.
async function listarFaturas(accountId) {
  const tentativas = [
    `/accounts/${encodeURIComponent(accountId)}/bills`,
    `/bills?account_id=${encodeURIComponent(accountId)}`,
  ];
  for (const p of tentativas) {
    try {
      const d = dados(await api(p));
      if (Array.isArray(d)) return d;
      if (d && Array.isArray(d.results)) return d.results;
    } catch { /* tenta o próximo caminho */ }
  }
  return [];
}

async function removerConexao(id) {
  try { await api(`/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { /* tolerante */ }
}

module.exports = {
  configurado, listarInstituicoes, criarIntegracao, getIntegracao,
  listarContas, listarInvestimentos, listarTransacoes, listarFaturas, removerConexao,
};
