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
/**
 * A conexão está VIVA (autorizada e importando)?
 *
 * ⚠️ Fronteira de segurança do `recreate`: a doc da Polp diz que recriar um
 * consentimento AUTORISED **revoga o atual** antes de criar o novo. Uma
 * conexão que funciona nunca pode entrar nesse caminho — por isso a lista é
 * de quem ESTÁ VIVO (allowlist), não de quem está morto: status novo que
 * apareça amanhã é tratado como morto, que é o lado seguro (no pior caso o
 * usuário refaz a autorização; no outro lado ele PERDE a conexão).
 * Os valores chegam em minúsculas (é como `of_conexoes.status` é gravado).
 */
const STATUS_VIVO = new Set(['updated', 'updating', 'authorised', 'authorized']);
function ehConexaoViva(status) {
  return STATUS_VIVO.has(String(status || '').toLowerCase());
}
/**
 * Qual tentativa MORTA dá pra reaproveitar neste banco — ou nenhuma.
 *
 * ⚠️ A REGRA É "TODAS MORTAS", NÃO "ALGUMA MORTA", e a diferença importa.
 * Medido na base em 13/09/2026: existem 4 pares (usuário, banco) com MAIS DE
 * UMA conexão — Nubank, Itaú, Mercado Pago e o próprio Santander. Ou seja,
 * ter duas contas no mesmo banco é caso real, não hipótese.
 *
 * Se alguma conexão daquele banco está VIVA, o usuário que clica "conectar"
 * quase certamente quer uma SEGUNDA conta (outro CPF). Reaproveitar a
 * tentativa morta ali entregaria a ele a autorização do CPF ERRADO — o
 * `recreate` mantém "instituição, CPF/CNPJ e demais campos" (doc da Polp).
 * Então: com qualquer viva por perto, o reuso sai de cena e tudo volta a ser
 * exatamente como era antes desta correção.
 *
 * Com TODAS mortas não há ambiguidade — é a mesma pessoa tentando o mesmo
 * banco de novo. Vale inclusive quando são duas mortas, que é o caso real do
 * cliente que tentou duas vezes em 55 minutos.
 *
 * ⚠️ `ultima_sync` preenchida conta como VIVA mesmo com status estranho: se a
 * conexão já trouxe dado alguma vez, ela é real e não se mexe nela por aqui.
 *
 * @param linhas de `of_conexoes`, MAIS RECENTE PRIMEIRO.
 */
function escolherTentativaMorta(linhas) {
  const arr = (linhas || []).filter(Boolean);
  if (!arr.length) return null;
  if (arr.some((c) => ehConexaoViva(c.status) || c.ultima_sync)) return null;
  return arr[0];
}
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
      // Só o trilho Celcoin tem /recreate. No Pluggy fica `undefined` e a
      // rota cai no caminho antigo — o `typeof === function` é a checagem.
      recriarConexao: (id, args) => cliente.recriarConsentimento(id, args || {}),
      precisaRenovar: (c, agora) => cliente.precisaRenovar(c, agora),
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

module.exports = {
  PLUGGY, CELCOIN, providerPadrao, normalizarProvider, para, paraConexao,
  ehConexaoViva, STATUS_VIVO, escolherTentativaMorta,
};
