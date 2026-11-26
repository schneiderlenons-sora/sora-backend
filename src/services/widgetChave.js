// ─────────────────────────────────────────────────────────────────────────────
// A chave do widget — conexão de um aparelho (migration 201).
//
// Fluxo: a pessoa, logada no app, toca em "Conectar widget". O site pede um
// CÓDIGO (uso único, 5 min) e o entrega ao app nativo (plugin no iPhone, link
// do app no Android). O app troca o código pela CHAVE e a guarda no aparelho.
// O widget usa a chave em GET /api/widget/resumo.
//
// Igual à conexão do ChatGPT/Claude (services/oauthIa.js):
//   · chave OPACA, só vale nos endereços /api/widget/* (o JWT do Supabase
//     valeria em toda rota do backend e direto no banco);
//   · NADA DE CHAVE EM TEXTO NO BANCO: guardamos o sha256;
//   · revogável aparelho por aparelho (Configurações → Widgets).
//
// O banco entra por parâmetro (`db`) pra o eval rodar com um falso.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const { CODIGO_TTL_S } = require('../config/widgets');

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const novo = (prefixo) => `${prefixo}_${crypto.randomBytes(32).toString('base64url')}`;
const iso = (ms) => new Date(ms).toISOString();

const PLATAFORMAS = ['ios', 'android'];
const FORMATO_CODIGO = /^sora_wc_[A-Za-z0-9_-]{43}$/;
const FORMATO_CHAVE = /^sora_wg_[A-Za-z0-9_-]{43}$/;

/** Cria um código de conexão de uso único pra esta conta. */
async function criarCodigo(db, userId, { agora = Date.now() } = {}) {
  const codigo = novo('sora_wc');
  const { error } = await db.from('widget_codigos').insert({
    codigo_hash: hash(codigo), user_id: userId,
    criado_em: iso(agora), expira_em: iso(agora + CODIGO_TTL_S * 1000),
  });
  if (error) throw new Error(error.message);
  return { codigo, expira_em: iso(agora + CODIGO_TTL_S * 1000) };
}

/**
 * Troca o código pela chave. Uso ÚNICO: a marcação de usado é condicional
 * (`usado_em is null`), então dois pedidos com o mesmo código não geram duas
 * chaves.
 * @returns {{ chave?: string, erro?: 'codigo_invalido'|'codigo_expirado'|'plataforma' }}
 */
async function trocarCodigo(db, { codigo, plataforma, aparelho }, { agora = Date.now() } = {}) {
  if (!PLATAFORMAS.includes(plataforma)) return { erro: 'plataforma' };
  if (!FORMATO_CODIGO.test(String(codigo || ''))) return { erro: 'codigo_invalido' };

  const { data: usado, error } = await db.from('widget_codigos')
    .update({ usado_em: iso(agora) })
    .eq('codigo_hash', hash(codigo)).is('usado_em', null)
    .select('user_id, expira_em').maybeSingle();
  if (error) throw new Error(error.message);
  if (!usado) return { erro: 'codigo_invalido' };
  if (new Date(usado.expira_em).getTime() < agora) return { erro: 'codigo_expirado' };

  const chave = novo('sora_wg');
  const { error: e2 } = await db.from('widget_conexoes').insert({
    user_id: usado.user_id, token_hash: hash(chave), plataforma,
    aparelho: String(aparelho || '').slice(0, 80) || null, criado_em: iso(agora),
  });
  if (e2) throw new Error(e2.message);
  return { chave };
}

/**
 * Lê o contexto da chave numa ida só (função `widget_contexto` da 201):
 * conta, plano, grupo e versão do grupo. `null` = chave inválida ou revogada.
 */
async function contexto(db, chave) {
  if (!FORMATO_CHAVE.test(String(chave || ''))) return null;
  const { data, error } = await db.rpc('widget_contexto', { p_hash: hash(chave) });
  if (error) throw new Error(error.message);
  return data || null;
}

/** Aparelhos conectados desta conta (Configurações → Widgets). */
async function listar(db, userId) {
  const { data, error } = await db.from('widget_conexoes')
    .select('id, plataforma, aparelho, criado_em, ultimo_uso_em')
    .eq('user_id', userId).is('revogado_em', null)
    .order('criado_em', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

/** Desliga um aparelho. Só o dono da conexão consegue (o `user_id` entra no filtro). */
async function revogar(db, { conexaoId, userId }, { agora = Date.now() } = {}) {
  const { data, error } = await db.from('widget_conexoes')
    .update({ revogado_em: iso(agora) })
    .eq('id', conexaoId).eq('user_id', userId).is('revogado_em', null)
    .select('id').maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

module.exports = { hash, criarCodigo, trocarCodigo, contexto, listar, revogar, FORMATO_CHAVE, FORMATO_CODIGO };
