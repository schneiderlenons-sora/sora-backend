// =====================================================================
// Dispatcher de provedor do Open Finance.
//
// A Sora fala com a Polp por DOIS trilhos, que convivem:
//   'polp'         → API v1 (Pluggy)  — services/polp.js  + polpSync.js
//   'polp-celcoin' → API v2 (Celcoin) — services/polpCelcoin.js + polpCelcoinSync.js
//
// Quem decide é `of_conexoes.provider`: nas operações sobre uma conexão que já
// existe, o provider vem do BANCO (não do cliente) — assim uma conexão Pluggy
// nunca é sincronizada pelo código da Celcoin e vice-versa.
//
// Mesmo padrão do services/mensageiro.js (Meta × Z-API) no WhatsApp.
// =====================================================================

const PLUGGY  = 'polp';
const CELCOIN = 'polp-celcoin';

/**
 * Trilho padrão quando ninguém disse qual usar. Mesma ideia do
 * WHATSAPP_PROVIDER (Meta × Z-API):
 *   1. `OPEN_FINANCE_PROVIDER` manda (celcoin | pluggy);
 *   2. sem a env, quem estiver CONFIGURADO ganha — e o Celcoin tem prioridade,
 *      porque quem configurou as credenciais v2 quer usá-las (era o bug: as
 *      envs do Celcoin estavam no Render, mas o /conectar caía no Pluggy e
 *      voltava 402 "plano ativo", já que o plano é do outro trilho);
 *   3. nada configurado → Pluggy (comportamento histórico).
 */
function providerPadrao() {
  const env = String(process.env.OPEN_FINANCE_PROVIDER || '').trim().toLowerCase();
  if (env === 'celcoin' || env === CELCOIN || env === 'v2') return CELCOIN;
  if (env === 'pluggy' || env === PLUGGY || env === 'v1') return PLUGGY;
  try {
    if (require('./polpCelcoin').configurado()) return CELCOIN;
  } catch { /* módulo indisponível → cai pro Pluggy */ }
  return PLUGGY;
}

/** Normaliza o que vem do cliente/banco pro nome canônico do provider. */
function normalizarProvider(p) {
  const s = String(p || '').trim().toLowerCase();
  if (!s) return providerPadrao();
  if (s === CELCOIN || s === 'celcoin' || s === 'v2') return CELCOIN;
  if (s === PLUGGY || s === 'pluggy' || s === 'v1') return PLUGGY;
  return providerPadrao();
}

/**
 * Devolve a implementação do provider:
 *   { provider, cliente, sincronizar(externalId, opts), rotulo }
 * `sincronizar` tem a MESMA assinatura nos dois trilhos, então quem chama não
 * precisa saber qual é.
 */
function para(provider) {
  const p = normalizarProvider(provider);
  if (p === CELCOIN) {
    const cliente = require('./polpCelcoin');
    const sync = require('./polpCelcoinSync');
    return {
      provider: CELCOIN,
      rotulo: 'Celcoin (v2)',
      cliente,
      configurado: () => cliente.configurado(),
      listarInstituicoes: () => cliente.listarInstituicoes(),
      criarConexao: (args) => cliente.criarConsentimento(args),
      getConexao: (id) => cliente.getConsentimento(id),
      removerConexao: (id) => cliente.revogarConsentimento(id),
      sincronizar: (id, opts) => sync.sincronizarConsentimento(id, opts),
      // Status que significa "pronto pra importar".
      statusOk: (st) => String(st || '').toUpperCase() === 'AUTHORISED',
    };
  }
  const cliente = require('./polp');
  const sync = require('./polpSync');
  return {
    provider: PLUGGY,
    rotulo: 'Pluggy (v1)',
    cliente,
    configurado: () => cliente.configurado(),
    listarInstituicoes: () => cliente.listarInstituicoes(),
    criarConexao: (args) => cliente.criarIntegracao(args),
    getConexao: (id) => cliente.getIntegracao(id),
    removerConexao: (id) => cliente.removerConexao(id),
    sincronizar: (id, opts) => sync.sincronizarConexao(id, opts),
    statusOk: (st) => ['UPDATED', 'OUTDATED'].includes(String(st || '').toUpperCase()),
  };
}

/** Provider de uma conexão existente — lido do BANCO, nunca do cliente. */
async function paraConexao(externalId, grupoId) {
  const supabase = require('../db/supabase');
  let q = supabase.from('of_conexoes').select('provider, external_id, grupo_id')
    .eq('external_id', String(externalId));
  if (grupoId) q = q.eq('grupo_id', grupoId);
  const { data } = await q.maybeSingle();
  if (!data) return null;
  return { ...para(data.provider), conexao: data };
}

module.exports = { PLUGGY, CELCOIN, providerPadrao, normalizarProvider, para, paraConexao };
