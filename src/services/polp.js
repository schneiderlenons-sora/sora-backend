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

// Transações de UMA conta. GET /accounts/{id}/transactions — paginado 50/página
// (meta.last_page).
//
// ⚠️ NÃO cortar a paginação por data. A API ordena por `id` DESC, e o id NÃO
// acompanha a data (no MP os ids saem 755033→2025-10-15, 755032→2025-11-14,
// 755031→2025-11-18: id descendo, data subindo). Havia um break "se a última
// da página já passou do corte" que assumia ordem por data DESC — com a ordem
// real ele para na página 1 e DESCARTA tudo que é recente. Pagina até o fim
// (last_page) e filtra a data no final, que é a única forma correta aqui.
async function listarTransacoes(accountId, dateFrom, { paginaMax = 300 } = {}) {
  const out = [];
  for (let page = 1; page <= paginaMax; page++) {
    const j = await api(`/accounts/${encodeURIComponent(accountId)}/transactions?page=${page}`);
    const results = j?.data || [];
    out.push(...results);
    const last = j?.meta?.last_page;
    if (!results.length || (last && page >= last)) break;
  }
  return dateFrom ? out.filter(t => String(t.date) >= dateFrom) : out;
}

// Faturas de UM cartão (doc "List Bills"): GET /accounts/{id}/bills — ordenadas
// por VENCIMENTO DECRESCENTE, 15 por página. Só contas type=CREDIT.
//
// ⚠️ Não é fonte confiável de "fatura atual": no Mercado Pago só voltam faturas
// ANTIGAS (a mais nova é a do mês passado, já paga) e as demais vêm com
// total_amount 0. Como a ordem é por vencimento DESC, o que interessa está na
// página 1 — se a fatura do mês não veio aqui, ela não existe na Polp.
async function listarFaturas(accountId) {
  try { return dados(await api(`/accounts/${encodeURIComponent(accountId)}/bills`)) || []; }
  catch { return []; }
}

// UMA fatura pelo id (doc "Get Bill"): GET /bills/{id}. Serve pra buscar fatura
// que as transações CITAM (tx.bill_id) mas que o List Bills não devolveu.
async function getFatura(billId) {
  return dados(await api(`/bills/${encodeURIComponent(billId)}`));
}

// Compras parceladas de um cartão (doc "List Installments by Account"):
// GET /accounts/{id}/installments — 25 por página.
//
// Importa pro cálculo da fatura: o `balance` do cartão é o LIMITE USADO, e
// parcela a vencer ocupa limite sem estar na fatura do mês. Então
// `fatura ≈ balance − parcelas futuras`.
async function listarParcelamentos(accountId, { paginaMax = 40 } = {}) {
  const out = [];
  for (let page = 1; page <= paginaMax; page++) {
    const j = await api(`/accounts/${encodeURIComponent(accountId)}/installments?page=${page}`);
    const results = j?.data || [];
    out.push(...results);
    const last = j?.meta?.last_page;
    if (!results.length || (last && page >= last)) break;
  }
  return out;
}

// Saldo AO VIVO (doc "Get Account Balance"): GET /accounts/{id}/balance.
// Diferente do balance que vem em /integrations/:id/accounts (valor persistido
// na Polp), este consulta o provedor bancário na hora e ressincroniza. Custa uma
// ida ao banco — usar só onde o número precisa estar fresco.
// NÃO engole o erro: quem chama decide (no cartão do MP isso volta erro, e o
// motivo importa).
async function saldoAoVivo(accountId) {
  return dados(await api(`/accounts/${encodeURIComponent(accountId)}/balance`));
}

async function removerConexao(id) {
  try { await api(`/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' }); } catch { /* tolerante */ }
}

module.exports = {
  configurado, listarInstituicoes, criarIntegracao, getIntegracao,
  listarContas, listarInvestimentos, listarTransacoes, listarFaturas, getFatura,
  listarParcelamentos, saldoAoVivo, removerConexao,
};
