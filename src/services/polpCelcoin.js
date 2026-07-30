// =====================================================================
// Cliente da API da Polp — trilho CELCOIN (v2).
// Base: https://api.polp.com.br/api/v2   ·   Doc: docs/CELCOIN-API.md
//
// ⚠️ NÃO confundir com services/polp.js, que é o trilho PLUGGY (v1). São APIs
// diferentes no mesmo provedor e os dois convivem (of_conexoes.provider decide).
//
// Auth: mesmos headers do v1 — x-api-client / x-api-secret em toda requisição.
// (GET /institutions é público, mas mandamos os headers de qualquer forma.)
//
// Diferenças que este cliente encapsula:
//   • paginação é CURSOR (`?cursor=`), não `?page=`. 15/pág (500 em transações);
//   • conexão é CONSENTIMENTO (`/consents`), status alvo = AUTHORISED;
//   • cartão é entidade separada (`/credit-cards`), com faturas/parcelas/recorrências;
//   • investimento tem 5 famílias, cada uma com endpoint próprio;
//   • endpoints de detalhe (show) têm rate limit de 30 req/min → preferimos
//     SEMPRE as listagens do consentimento (que já trazem tudo via eager load).
// =====================================================================

const BASE          = () => process.env.POLP_CELCOIN_API_URL || 'https://api.polp.com.br/api/v2';
const CLIENT_ID     = () => process.env.POLP_CELCOIN_CLIENT_ID || process.env.POLP_CLIENT_ID;
const CLIENT_SECRET = () => process.env.POLP_CELCOIN_CLIENT_SECRET || process.env.POLP_CLIENT_SECRET;

const PROVIDER = 'polp-celcoin';

function configurado() {
  return !!(CLIENT_ID() && CLIENT_SECRET());
}

// Erro tipado — deixa quem chama distinguir "plano vencido" de "banco fora do ar".
class CelcoinError extends Error {
  constructor(message, { status, body, path } = {}) {
    super(message);
    this.name = 'CelcoinError';
    this.status = status || null;
    this.body = body || null;
    this.path = path || null;
    // 401 credencial · 402 plano/fatura · 403 conta pendente · 429 rate limit
    this.credencial   = status === 401;
    this.planoBloqueado = status === 402;
    this.contaPendente  = status === 403;
    this.rateLimit    = status === 429;
  }
}

async function api(path, { method = 'GET', body, tentativa = 0 } = {}) {
  if (!configurado()) {
    throw new CelcoinError('Celcoin não configurado (faltam POLP_CELCOIN_CLIENT_ID / POLP_CELCOIN_CLIENT_SECRET).');
  }
  let r;
  try {
    r = await fetch(`${BASE()}${path}`, {
      method,
      headers: {
        'x-api-client': CLIENT_ID(),
        'x-api-secret': CLIENT_SECRET(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new CelcoinError(`Celcoin ${method} ${path} → rede: ${e.message}`, { path });
  }

  if (r.status === 429 && tentativa < 2) {
    // Rate limit (30 req/min nos show). Respeita Retry-After e tenta de novo.
    const espera = Math.min(Number(r.headers.get('retry-after')) || 5, 30);
    await new Promise((res) => setTimeout(res, espera * 1000));
    return api(path, { method, body, tentativa: tentativa + 1 });
  }

  if (!r.ok) {
    const texto = await r.text().catch(() => '');
    let corpo = null;
    try { corpo = JSON.parse(texto); } catch { /* texto puro */ }
    const msg = (corpo && corpo.message) || texto || r.statusText;
    throw new CelcoinError(`Celcoin ${method} ${path} → ${r.status} ${msg}`.slice(0, 400), {
      status: r.status, body: corpo, path,
    });
  }
  if (r.status === 204) return {};
  return r.json();
}

// Respostas vêm como { data, links, meta }.
const dados = (j) => (j && j.data !== undefined ? j.data : j);

/**
 * Percorre TODAS as páginas seguindo `meta.next_cursor`.
 * `max` limita o número de páginas (guarda contra loop infinito / conta gigante).
 */
async function paginado(path, { max = 40, query = {} } = {}) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < max; i++) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v != null && v !== ''),
    );
    if (cursor) qs.set('cursor', cursor);
    const sep = path.includes('?') ? '&' : '?';
    const j = await api(`${path}${qs.toString() ? sep + qs.toString() : ''}`);
    const pagina = dados(j);
    if (Array.isArray(pagina)) out.push(...pagina);
    cursor = (j && j.meta && j.meta.next_cursor) || null;
    if (!cursor || !Array.isArray(pagina) || !pagina.length) break;
  }
  return out;
}

// ── Instituições (seletor de banco) ─────────────────────────────────────────
// `credentials[]` diz quais campos o consent exige (ex.: cpf, cnpj).
// Só criar consent quando `status === 'OPERATIONAL'`.
async function listarInstituicoes() {
  try { return await paginado('/institutions', { max: 20 }); }
  catch (e) { console.warn('[celcoin] instituicoes:', e.message); return []; }
}

// ── Consentimento (o "conectar banco") ──────────────────────────────────────
//
// ⚠️ NÃO mandar uma lista fixa de `products`. O Open Finance tem regras de
// combinação de permissões (BACEN) que variam POR INSTITUIÇÃO, e a doc da Polp
// não publica quais são — mandar um conjunto fixo devolve
// `422 COMBINACAO_PERMISSOES_INCORRETA` no banco que não oferece algum deles.
// A doc diz: "Se omitido, solicita todos os produtos disponíveis" — ou seja, a
// Polp resolve a combinação válida daquela instituição. É o caminho certo.
//
// Se o chamador passar `products`, respeitamos (uso avançado). Sem isso,
// tentamos: omitir → essenciais → só conta, parando no primeiro que passar.
const PRODUTOS_ESSENCIAIS = ['ACCOUNT', 'CREDIT_CARD_ACCOUNT'];

/** É o 422 de combinação inválida de permissões? */
function ehCombinacaoInvalida(e) {
  if (!e || e.status !== 422) return false;
  const txt = JSON.stringify(e.body || e.message || '').toUpperCase();
  return txt.includes('COMBINACAO_PERMISSOES') || txt.includes('PERMISSOES');
}

async function criarConsentimento({ institutionId, cpf, cnpj, products, credenciais } = {}) {
  const base = { institution_id: String(institutionId) };
  if (cpf)  base.cpf  = String(cpf).replace(/\D/g, '');
  if (cnpj) base.cnpj = String(cnpj).replace(/\D/g, '');
  // Campos dinâmicos exigidos por `institution.credentials` (ex.: username/password).
  if (credenciais && typeof credenciais === 'object') Object.assign(base, credenciais);

  // `undefined` = não enviar o campo (deixa a Polp escolher os disponíveis).
  const tentativas = (products && products.length)
    ? [products]
    : [undefined, PRODUTOS_ESSENCIAIS, ['ACCOUNT']];

  let ultimoErro = null;
  for (const prods of tentativas) {
    const body = prods ? { ...base, products: prods } : { ...base };
    try {
      const d = dados(await api('/consents', { method: 'POST', body }));
      return {
        id: d.id,
        status: d.status,                          // AWAITING_AUTHORIZATION | AUTHORISED | …
        urlToAuthenticate: d.url_to_authenticate || null,
        urlExpiraEm: d.url_to_authenticate_expires_at || null,
        produtos: d.products || [],
        produtosPedidos: prods || 'todos os disponíveis',
        erro: d.error || null,
      };
    } catch (e) {
      ultimoErro = e;
      // Só vale insistir quando o problema é a COMBINAÇÃO de permissões.
      // Credencial/plano/instituição fora do ar não melhoram com menos produtos.
      if (!ehCombinacaoInvalida(e)) throw e;
      console.warn('[celcoin] combinação de permissões recusada com',
        prods ? prods.join(',') : '(todos disponíveis)', '— tentando conjunto menor');
    }
  }
  throw ultimoErro;
}

async function getConsentimento(id) {
  return dados(await api(`/consents/${encodeURIComponent(id)}`));
}

async function revogarConsentimento(id) {
  try { return await api(`/consents/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  catch (e) { console.warn('[celcoin] revogar:', e.message); return null; }
}

async function listarConsentimentos() {
  return paginado('/consents');
}

// Cronograma de sync (last_sync_at / next_sync_at por recurso).
async function syncSchedules(consentId) {
  try { return await paginado(`/consents/${encodeURIComponent(consentId)}/sync-schedules`, { max: 5 }); }
  catch { return []; }
}

// ── Contas ──────────────────────────────────────────────────────────────────
// Traz identification + balance + overdraft_limit por eager loading (podem ser
// null antes da 1ª sincronização — isso é normal, não é erro).
async function listarContas(consentId, query = {}) {
  return paginado(`/consents/${encodeURIComponent(consentId)}/accounts`, { query });
}

// Transações da conta. 500/página. `fromDate`/`toDate` filtram transaction_date_time.
async function listarTransacoesConta(accountId, { fromDate, toDate, max = 20 } = {}) {
  return paginado(`/accounts/${encodeURIComponent(accountId)}/transactions`, {
    max, query: { fromDate, toDate },
  });
}

// ── Cartões (entidade SEPARADA no v2) ───────────────────────────────────────
async function listarCartoes(consentId, query = {}) {
  return paginado(`/consents/${encodeURIComponent(consentId)}/credit-cards`, { query });
}

async function listarTransacoesCartao(cardId, { fromDate, toDate, max = 20 } = {}) {
  return paginado(`/credit-cards/${encodeURIComponent(cardId)}/transactions`, {
    max, query: { fromDate, toDate },
  });
}

// Faturas: traz bill_closing_date, due_date, bill_total_amount,
// bill_minimum_amount, payments[] e finance_charges[]. É a FONTE da fatura.
async function listarFaturas(cardId, { max = 8 } = {}) {
  try { return await paginado(`/credit-cards/${encodeURIComponent(cardId)}/bills`, { max }); }
  catch (e) { console.warn('[celcoin] bills:', e.message); return []; }
}

// Parcelamentos derivados pela Polp: totalInstallments / paidInstallments /
// occurrences[]. ⚠️ paidInstallments = parcelas ENCONTRADAS, não necessariamente pagas.
async function listarParcelamentos(cardId, { max = 10 } = {}) {
  try { return await paginado(`/credit-cards/${encodeURIComponent(cardId)}/installments`, { max }); }
  catch (e) { console.warn('[celcoin] installments:', e.message); return []; }
}

// Assinaturas/recorrências detectadas (periodMonths, expectedDay, nextExpectedAt,
// regularityScore). Precisa de ≥3 meses cobrados pra aparecer.
async function listarRecorrencias(cardId, { max = 10 } = {}) {
  try { return await paginado(`/credit-cards/${encodeURIComponent(cardId)}/recurrings`, { max }); }
  catch (e) { console.warn('[celcoin] recurrings:', e.message); return []; }
}

// ── Crédito: empréstimos e financiamentos ───────────────────────────────────
async function listarEmprestimos(consentId, query = {}) {
  try { return await paginado(`/consents/${encodeURIComponent(consentId)}/loans`, { query }); }
  catch (e) { console.warn('[celcoin] loans:', e.message); return []; }
}

async function listarFinanciamentos(consentId, query = {}) {
  try { return await paginado(`/consents/${encodeURIComponent(consentId)}/financings`, { query }); }
  catch (e) { console.warn('[celcoin] financings:', e.message); return []; }
}

// ── Investimentos: 5 famílias, endpoints próprios ───────────────────────────
// `familia` casa com o path e com o evento de webhook.
const FAMILIAS_INVESTIMENTO = [
  { familia: 'bank_fixed_income',   path: 'bank-fixed-incomes'   },
  { familia: 'credit_fixed_income', path: 'credit-fixed-incomes' },
  { familia: 'fund',                path: 'funds'                },
  { familia: 'treasure_title',      path: 'treasure-titles'      },
  { familia: 'variable_income',     path: 'variable-incomes'     },
];

async function listarInvestimentosFamilia(consentId, path, query = {}) {
  try { return await paginado(`/consents/${encodeURIComponent(consentId)}/${path}`, { query }); }
  catch (e) { console.warn(`[celcoin] ${path}:`, e.message); return []; }
}

/** Todos os investimentos do consentimento, com a família marcada em cada item. */
async function listarInvestimentos(consentId, query = {}) {
  const out = [];
  for (const { familia, path } of FAMILIAS_INVESTIMENTO) {
    const itens = await listarInvestimentosFamilia(consentId, path, query);
    for (const i of itens) out.push({ ...i, __familia: familia, __path: path });
  }
  return out;
}

async function listarTransacoesInvestimento(path, investimentoId, { fromDate, toDate, max = 10 } = {}) {
  try {
    return await paginado(`/${path}/${encodeURIComponent(investimentoId)}/transactions`, {
      max, query: { fromDate, toDate },
    });
  } catch (e) { console.warn(`[celcoin] ${path}/transactions:`, e.message); return []; }
}

// ── Alertas de status da plataforma (público, e fica na v1) ──────────────────
async function alertas() {
  try {
    const base = (process.env.POLP_CELCOIN_API_URL || 'https://api.polp.com.br/api/v2')
      .replace(/\/api\/v2\/?$/, '/api/v1');
    const r = await fetch(`${base}/alerts?provider=celcoin`, { headers: { Accept: 'application/json' } });
    if (!r.ok) return [];
    return dados(await r.json()) || [];
  } catch { return []; }
}

module.exports = {
  PROVIDER, PRODUTOS_ESSENCIAIS, FAMILIAS_INVESTIMENTO, CelcoinError, ehCombinacaoInvalida,
  configurado, api, paginado,
  listarInstituicoes,
  criarConsentimento, getConsentimento, revogarConsentimento, listarConsentimentos, syncSchedules,
  listarContas, listarTransacoesConta,
  listarCartoes, listarTransacoesCartao, listarFaturas, listarParcelamentos, listarRecorrencias,
  listarEmprestimos, listarFinanciamentos,
  listarInvestimentos, listarInvestimentosFamilia, listarTransacoesInvestimento,
  alertas,
};
