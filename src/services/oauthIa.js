// ─────────────────────────────────────────────────────────────────────────────
// OAuth 2.1 da Sora no ChatGPT — servidor de autorização mínimo e próprio.
//
// POR QUE PRÓPRIO, e não o "OAuth Server" do Supabase. O token que o Supabase
// emitiria é um JWT de usuário comum: valeria em TODA rota do backend (inclusive
// as de escrita) e direto na API do banco. Aqui o token é OPACO, só é aceito no
// /mcp, tem escopo de leitura e é revogável conexão por conexão.
//
// O que está implementado, e só isso:
//   · authorization code + PKCE S256 (obrigatório), código de uso único, 5 min;
//   · cliente identificado por URL (Client ID Metadata Document) — só ChatGPT;
//   · refresh com rotação (o antigo vale mais 5 min, pra resposta perdida);
//   · revogação (RFC 7009) e pela tela "Sora no ChatGPT".
//
// ⚠️ NADA DE TOKEN EM TEXTO NO BANCO: guardamos o sha256. Vazou a tabela, não
// vazou acesso.
//
// O banco entra por parâmetro (`db`) pra o eval rodar com um falso.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const cfg = require('../config/iaConectada');

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const novoToken = (prefixo) => `${prefixo}_${crypto.randomBytes(32).toString('base64url')}`;
const iso = (ms) => new Date(ms).toISOString();

const VERIFIER_OK = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_OK = /^[A-Za-z0-9_-]{43}$/;   // base64url de um sha256

function iguais(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** O `code_verifier` gera o `code_challenge` guardado? (PKCE S256) */
function pkceConfere(verifier, challenge) {
  if (!VERIFIER_OK.test(verifier || '') || !CHALLENGE_OK.test(challenge || '')) return false;
  return iguais(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge);
}

/** Endereço de retorno aceito? https, nos domínios DO PRÓPRIO cliente, sem fragmento. */
function retornoAceito(u, origens) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && !url.hash && !url.username && (origens || []).includes(url.origin);
  } catch { return false; }
}

// ── Cliente (Client ID Metadata Document) ───────────────────────────────────
const cacheClientes = new Map();   // client_id → { cliente, ate }

/**
 * Resolve o cliente pelo `client_id` (que é uma URL da OpenAI).
 * @returns {Promise<{ id: string, nome: string, logo: string|null, redirects: string[] } | null>}
 */
async function buscarCliente(clientId, { buscar = fetch, agora = Date.now() } = {}) {
  const conhecido = cfg.clienteDoId(clientId);
  if (!conhecido) return null;
  const hit = cacheClientes.get(clientId);
  if (hit && hit.ate > agora) return hit.cliente;

  let doc = null;
  try {
    const r = await buscar(clientId, {
      headers: { accept: 'application/json' },
      redirect: 'error',                     // nada de seguir pra outro host
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const j = await r.json();
      // O documento tem de se declarar ele mesmo (spec do CIMD).
      if (j && typeof j === 'object' && j.client_id === clientId) doc = j;
    }
  } catch { /* a OpenAI fora do ar não pode travar quem já conhecemos */ }
  if (!doc && cfg.CLIENTES_CONHECIDOS[clientId]) doc = { client_id: clientId, ...cfg.CLIENTES_CONHECIDOS[clientId] };
  if (!doc) return null;

  const redirects = (Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [])
    .filter((u) => typeof u === 'string' && retornoAceito(u, conhecido.origens));
  if (!redirects.length) return null;
  const logo = typeof doc.logo_uri === 'string' && /^https:\/\//.test(doc.logo_uri) ? doc.logo_uri : null;
  const cliente = {
    id: clientId, nome: String(doc.client_name || conhecido.nome).slice(0, 60), logo, redirects,
    chave: conhecido.chave, empresa: conhecido.empresa,
  };
  // Só cacheia o que veio da OpenAI de verdade; o conhecido é barato de refazer.
  cacheClientes.set(clientId, { cliente, ate: agora + 60 * 60 * 1000 });
  return cliente;
}

// ── Pedido de autorização (a tela de consentimento) ─────────────────────────
/**
 * Confere os parâmetros que o ChatGPT/Claude mandou pra /oauth/autorizar.
 *
 * ⚠️ DOIS TIPOS DE ERRO. Enquanto cliente e endereço de retorno não foram
 * confirmados, o erro NUNCA volta pro endereço de retorno (seria redirecionar
 * pra um lugar que não conferimos): `redirecionar: false`, a tela mostra.
 * Depois disso, o erro volta pro cliente, como manda o OAuth.
 */
async function validarPedido(p, opts = {}) {
  const q = p || {};
  const cliente = await buscarCliente(q.client_id, opts);
  if (!cliente) return { ok: false, redirecionar: false, erro: 'invalid_client', descricao: 'Aplicativo não reconhecido.' };
  const redirect = typeof q.redirect_uri === 'string' ? q.redirect_uri : '';
  if (!redirect || !cliente.redirects.includes(redirect)) {
    return { ok: false, redirecionar: false, erro: 'invalid_request', descricao: 'Endereço de retorno não autorizado.' };
  }
  const state = typeof q.state === 'string' ? q.state.slice(0, 2000) : undefined;
  const voltar = (erro, descricao) => ({ ok: false, redirecionar: true, erro, descricao, redirect_uri: redirect, state });

  if (q.response_type !== 'code') return voltar('unsupported_response_type', 'Só o fluxo com código é aceito.');
  if (q.code_challenge_method !== 'S256' || !CHALLENGE_OK.test(q.code_challenge || '')) {
    return voltar('invalid_request', 'PKCE com S256 é obrigatório.');
  }
  // O ChatGPT sempre manda `resource`. Se vier, tem de ser este servidor.
  if (q.resource !== undefined && q.resource !== cfg.recurso) return voltar('invalid_target', 'Recurso desconhecido.');

  // Escopo: só os que existem. Pedido sem escopo (ou só com desconhecidos)
  // recebe a leitura — é o único que há na fase 1.
  const pedidos = String(q.scope || '').split(/\s+/).filter(Boolean);
  const validos = pedidos.filter((s) => cfg.escoposSuportados.includes(s));
  const escopo = (validos.length ? validos : [cfg.ESCOPO_LEITURA]).join(' ');

  return {
    ok: true,
    cliente: { id: cliente.id, nome: cliente.nome, logo: cliente.logo, host: new URL(redirect).host, chave: cliente.chave, empresa: cliente.empresa },
    redirect_uri: redirect, state, escopo, recurso: cfg.recurso, code_challenge: q.code_challenge,
  };
}

/** URL de volta pro cliente. Sempre com `iss` (RFC 9207 — o ChatGPT confere). */
function urlRetorno(redirectUri, params) {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries({ ...params, iss: cfg.issuer })) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** A pessoa aprovou: grava o código e devolve pra onde o navegador vai. */
async function aprovar(db, { userId, pedido, agora = Date.now() }) {
  const code = novoToken('sora_cod');
  const { error } = await db.from('ia_oauth_codigos').insert({
    codigo_hash: hash(code), user_id: userId,
    cliente_id: pedido.cliente.id, cliente_nome: pedido.cliente.nome,
    redirect_uri: pedido.redirect_uri, code_challenge: pedido.code_challenge,
    escopo: pedido.escopo, recurso: pedido.recurso,
    expira_em: iso(agora + cfg.CODIGO_TTL_S * 1000),
  });
  if (error) throw new Error(`código não gravado: ${error.message}`);
  return urlRetorno(pedido.redirect_uri, { code, state: pedido.state });
}

/** A pessoa negou: volta pro cliente com `access_denied`. */
function negar(pedido) {
  return urlRetorno(pedido.redirect_uri, {
    error: 'access_denied', error_description: 'A pessoa não autorizou.', state: pedido.state,
  });
}

// ── Tokens ──────────────────────────────────────────────────────────────────
const erroToken = (error, error_description, status = 400) => ({ erro: { status, corpo: { error, error_description } } });

function emitir(agora) {
  const access = novoToken('sora_at');
  const refresh = novoToken('sora_rt');
  return {
    access, refresh,
    colunas: {
      access_hash: hash(access), access_expira_em: iso(agora + cfg.ACCESS_TTL_S * 1000),
      refresh_hash: hash(refresh), refresh_expira_em: iso(agora + cfg.REFRESH_TTL_S * 1000),
    },
  };
}

const respostaToken = (t, escopo) => ({
  access_token: t.access, token_type: 'Bearer', expires_in: cfg.ACCESS_TTL_S,
  refresh_token: t.refresh, scope: escopo,
});

/** grant_type=authorization_code */
async function trocarCodigo(db, p, { agora = Date.now() } = {}) {
  const code = String(p.code || '');
  if (!code) return erroToken('invalid_request', 'Falta o código.');
  const h = hash(code);

  // ⚠️ QUEIMA O CÓDIGO ANTES DE QUALQUER COISA. O `update ... is null` é a
  // trava: duas trocas simultâneas do mesmo código, só uma marca.
  const { data: marcados, error: eMarca } = await db.from('ia_oauth_codigos')
    .update({ usado_em: iso(agora) }).eq('codigo_hash', h).is('usado_em', null).select('*');
  if (eMarca) throw new Error(`código: ${eMarca.message}`);
  const row = marcados && marcados[0];
  if (!row) {
    // Código reapresentado: o OAuth manda derrubar o que ele gerou (quem tem o
    // código pode ter sido interceptado).
    const { data: velho } = await db.from('ia_oauth_codigos').select('conexao_id').eq('codigo_hash', h).maybeSingle();
    if (velho?.conexao_id) await revogar(db, { conexaoId: velho.conexao_id, agora });
    return erroToken('invalid_grant', 'Código inválido ou já usado.');
  }
  if (new Date(row.expira_em).getTime() < agora) return erroToken('invalid_grant', 'Código vencido.');
  if (p.client_id !== undefined && p.client_id !== row.cliente_id) return erroToken('invalid_grant', 'Código de outro aplicativo.');
  if (p.redirect_uri !== row.redirect_uri) return erroToken('invalid_grant', 'Endereço de retorno diferente.');
  if (p.resource !== undefined && p.resource !== row.recurso) return erroToken('invalid_target', 'Recurso diferente.');
  if (!pkceConfere(p.code_verifier, row.code_challenge)) return erroToken('invalid_grant', 'PKCE não confere.');

  // Uma conexão viva por aplicativo e por pessoa: conectar de novo troca a
  // anterior (menos token vivo por aí, e a lista da tela não acumula).
  await db.from('ia_conexoes').update({ revogada_em: iso(agora) })
    .eq('user_id', row.user_id).eq('cliente_id', row.cliente_id).is('revogada_em', null);

  const t = emitir(agora);
  const { data: conexao, error } = await db.from('ia_conexoes').insert({
    user_id: row.user_id, cliente_id: row.cliente_id, cliente_nome: row.cliente_nome,
    escopo: row.escopo, recurso: row.recurso, ...t.colunas,
  }).select('id').single();
  if (error || !conexao) throw new Error(`conexão não gravada: ${error?.message || 'sem linha'}`);
  await db.from('ia_oauth_codigos').update({ conexao_id: conexao.id }).eq('codigo_hash', h);
  limparCacheDoUsuario(row.user_id);
  return { corpo: respostaToken(t, row.escopo) };
}

/** grant_type=refresh_token (com rotação) */
async function renovar(db, p, { agora = Date.now(), tentativa = 1 } = {}) {
  const rt = String(p.refresh_token || '');
  if (!rt) return erroToken('invalid_request', 'Falta o refresh_token.');
  const h = hash(rt);

  let { data: row } = await db.from('ia_conexoes').select('*').eq('refresh_hash', h).is('revogada_em', null).maybeSingle();
  if (!row) {
    // O antigo ainda vale por alguns minutos depois da rotação: se a resposta
    // da renovação se perdeu na rede, o ChatGPT tenta de novo com ele.
    const r2 = await db.from('ia_conexoes').select('*').eq('refresh_anterior_hash', h).is('revogada_em', null).maybeSingle();
    const ant = r2.data;
    const dentroDaGraca = ant?.refresh_rotacionado_em
      && agora - new Date(ant.refresh_rotacionado_em).getTime() <= cfg.REFRESH_GRACA_S * 1000;
    if (dentroDaGraca) row = ant;
  }
  if (!row) return erroToken('invalid_grant', 'Refresh token inválido.');
  if (new Date(row.refresh_expira_em).getTime() < agora) return erroToken('invalid_grant', 'Conexão vencida. Conecte de novo.');
  if (p.client_id !== undefined && p.client_id !== row.cliente_id) return erroToken('invalid_grant', 'Token de outro aplicativo.');
  if (p.resource !== undefined && p.resource !== row.recurso) return erroToken('invalid_target', 'Recurso diferente.');

  const t = emitir(agora);
  // Trava contra duas renovações simultâneas: só grava se ninguém trocou antes.
  const { data: feitos, error } = await db.from('ia_conexoes')
    .update({ ...t.colunas, refresh_anterior_hash: h, refresh_rotacionado_em: iso(agora) })
    .eq('id', row.id).eq('refresh_hash', row.refresh_hash).select('id');
  if (error) throw new Error(`renovação: ${error.message}`);
  if (!feitos || !feitos.length) {
    // Perdeu a corrida: a outra renovação já marcou este token como "anterior",
    // então a segunda tentativa entra pela graça.
    if (tentativa < 2) return renovar(db, p, { agora, tentativa: tentativa + 1 });
    return erroToken('invalid_grant', 'Refresh token já usado.');
  }
  limparCacheDoUsuario(row.user_id);
  return { corpo: respostaToken(t, row.escopo) };
}

// ── Validação do token no /mcp ──────────────────────────────────────────────
// Cache de 60 s, igual ao do JWT (middlewares/auth.js): uma conversa no ChatGPT
// chama várias ferramentas em sequência com o mesmo token.
const TTL_CACHE_MS = 60_000;
const cacheAcesso = new Map();   // hash → { info, ate }

function limparCacheDoUsuario(userId) {
  for (const [k, v] of cacheAcesso) if (v.info?.userId === userId) cacheAcesso.delete(k);
}

/** @returns {Promise<{ conexaoId: string, userId: string, escopo: string, recurso: string, cliente: string } | null>} */
async function validarAcesso(db, token, { agora = Date.now() } = {}) {
  if (typeof token !== 'string' || !token.startsWith('sora_at_')) return null;
  const h = hash(token);
  const hit = cacheAcesso.get(h);
  if (hit && hit.ate > agora) return hit.info;
  if (hit) cacheAcesso.delete(h);

  const { data: row } = await db.from('ia_conexoes')
    .select('id, user_id, escopo, recurso, cliente_nome, access_expira_em, revogada_em')
    .eq('access_hash', h).maybeSingle();
  if (!row || row.revogada_em) return null;
  const expira = new Date(row.access_expira_em).getTime();
  if (!(expira > agora)) return null;
  if (row.recurso !== cfg.recurso) return null;   // token emitido pra outro endereço

  const info = { conexaoId: row.id, userId: row.user_id, escopo: row.escopo, recurso: row.recurso, cliente: row.cliente_nome };
  if (cacheAcesso.size >= 2000) cacheAcesso.clear();
  cacheAcesso.set(h, { info, ate: Math.min(agora + TTL_CACHE_MS, expira) });
  return info;
}

// ── Revogação ───────────────────────────────────────────────────────────────
async function revogar(db, { conexaoId, userId, agora = Date.now() }) {
  let q = db.from('ia_conexoes').update({ revogada_em: iso(agora) }).eq('id', conexaoId).is('revogada_em', null);
  if (userId) q = q.eq('user_id', userId);         // pela tela: só a própria
  const { data, error } = await q.select('id, user_id');
  if (error) throw new Error(`revogar: ${error.message}`);
  for (const r of data || []) limparCacheDoUsuario(r.user_id);
  return (data || []).length > 0;
}

/** RFC 7009: revoga pelo token (access ou refresh). Responde 200 sempre. */
async function revogarPorToken(db, token, { agora = Date.now() } = {}) {
  if (!token) return;
  const h = hash(token);
  for (const col of ['access_hash', 'refresh_hash']) {
    const { data } = await db.from('ia_conexoes').select('id').eq(col, h).is('revogada_em', null).maybeSingle();
    if (data?.id) { await revogar(db, { conexaoId: data.id, agora }); return; }
  }
}

// ── Registro de uso (o que o ChatGPT consultou) ─────────────────────────────
// `ultimo_uso_em` grava no máximo a cada 5 min por conexão: cada ida ao banco
// custa egress, e "usado há 3 minutos" não precisa de precisão de segundo.
const ultimoGravado = new Map();
function registrarUso(db, { conexaoId, userId, ferramenta, ok, ms, agora = Date.now() }) {
  const tarefas = [
    db.from('ia_acessos').insert({ conexao_id: conexaoId, user_id: userId, ferramenta, ok: !!ok, ms: Math.round(ms || 0) }),
  ];
  if (!ultimoGravado.has(conexaoId) || agora - ultimoGravado.get(conexaoId) > 5 * 60 * 1000) {
    ultimoGravado.set(conexaoId, agora);
    tarefas.push(db.from('ia_conexoes').update({ ultimo_uso_em: iso(agora) }).eq('id', conexaoId));
  }
  // Nunca derruba a resposta da ferramenta.
  return Promise.allSettled(tarefas.map((t) => Promise.resolve(t))).then((rs) => {
    for (const r of rs) {
      const e = r.status === 'rejected' ? r.reason : r.value?.error;
      if (e) console.warn('[ia] registrar uso:', e.message || e);
    }
  });
}

module.exports = {
  hash, pkceConfere, retornoAceito, buscarCliente, validarPedido, urlRetorno,
  aprovar, negar, trocarCodigo, renovar, validarAcesso, revogar, revogarPorToken, registrarUso,
  _limparCaches: () => { cacheClientes.clear(); cacheAcesso.clear(); ultimoGravado.clear(); },
};
