// ─────────────────────────────────────────────────────────────────────────────
// Sora no ChatGPT — o servidor MCP e o OAuth dele.
//
//   GET  /.well-known/oauth-protected-resource[/mcp]   quem protege o /mcp
//   GET  /.well-known/oauth-authorization-server       como pedir acesso
//   POST /oauth/token                                  código → token / renovar
//   POST /oauth/revoke                                 RFC 7009
//   POST /mcp                                          as ferramentas (stateless)
//
//   (painel, com o JWT da pessoa)
//   GET    /api/ia-conectada/pedido      confere o pedido da tela de consentimento
//   POST   /api/ia-conectada/aprovar     a pessoa permitiu → URL de volta
//   POST   /api/ia-conectada/negar       a pessoa negou    → URL de volta
//   GET    /api/ia-conectada/conexoes    a aba "ChatGPT": conexões e consultas
//   DELETE /api/ia-conectada/conexoes/:id  desconectar
//
// A tela de consentimento mora no site (www.forsora.com/oauth/autorizar): é lá
// que a pessoa está logada. O `authorization_endpoint` aponta pra ela.
//
// ⚠️ SÓ LEITURA na fase 1, e garantido em três lugares: as ferramentas só
// fazem GET, a assinatura interna só vale em GET (services/chamadaInterna.js)
// e o token não é aceito em nenhuma outra rota do backend.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const rateLimit = require('express-rate-limit');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const supabase = require('../db/supabase');
const auth = require('../middlewares/auth');
const cfg = require('../config/iaConectada');
const oauth = require('../services/oauthIa');
const { descritores, porNome, ErroFerramenta } = require('../services/ferramentasIa');
const { getInterno } = require('../services/chamadaInterna');
const { moedaBaseDoGrupo } = require('../services/moeda');
const { hojeSP } = require('../services/cicloFatura');

const router = express.Router();

// ── Metadados ───────────────────────────────────────────────────────────────
const metaRecurso = () => ({
  resource: cfg.recurso,
  authorization_servers: [cfg.issuer],
  scopes_supported: cfg.escoposSuportados,
  bearer_methods_supported: ['header'],
  resource_name: 'Sora',
  resource_policy_uri: cfg.politicaUrl,
  resource_tos_uri: cfg.termosUrl,
});
router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
  (req, res) => res.json(metaRecurso()));

router.get('/.well-known/oauth-authorization-server', (req, res) => res.json({
  issuer: cfg.issuer,
  authorization_endpoint: cfg.autorizarUrl,
  token_endpoint: cfg.tokenEndpoint,
  revocation_endpoint: cfg.revogarEndpoint,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  // Cliente público com PKCE: o ChatGPT escolhe `none` na interseção.
  token_endpoint_auth_methods_supported: ['none'],
  revocation_endpoint_auth_methods_supported: ['none'],
  scopes_supported: cfg.escoposSuportados,
  // O cliente se identifica por URL (só o ChatGPT — ver config/iaConectada.js).
  // Sem `registration_endpoint`: não há cadastro aberto de cliente.
  client_id_metadata_document_supported: true,
  // Devolvemos `iss` em TODA resposta de autorização (oauthIa.urlRetorno).
  authorization_response_iss_parameter_supported: true,
  op_policy_uri: cfg.politicaUrl,
  op_tos_uri: cfg.termosUrl,
}));

// ── Token e revogação ───────────────────────────────────────────────────────
// Por IP. O ChatGPT renova de poucos IPs, então o teto é folgado; o que ele
// barra é força bruta de código/refresh (que de todo jeito é inviável: 256 bits).
const limiteToken = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: 'temporarily_unavailable', error_description: 'Muitas requisições.' } });
const formulario = express.urlencoded({ extended: false, limit: '20kb' });

router.post('/oauth/token', limiteToken, formulario, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  if (!cfg.ativa()) return res.status(400).json({ error: 'invalid_grant', error_description: 'Conexão desligada.' });
  const b = req.body || {};
  try {
    let r;
    if (b.grant_type === 'authorization_code') r = await oauth.trocarCodigo(supabase, b);
    else if (b.grant_type === 'refresh_token') r = await oauth.renovar(supabase, b);
    else return res.status(400).json({ error: 'unsupported_grant_type' });
    if (r.erro) {
      console.warn('[ia] token recusado:', b.grant_type, r.erro.corpo.error, r.erro.corpo.error_description);
      return res.status(r.erro.status).json(r.erro.corpo);
    }
    return res.json(r.corpo);
  } catch (e) {
    console.error('[ia] token:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

router.post('/oauth/revoke', limiteToken, formulario, async (req, res) => {
  try { await oauth.revogarPorToken(supabase, (req.body || {}).token); } catch (e) { console.warn('[ia] revoke:', e.message); }
  res.sendStatus(200);   // RFC 7009: responde 200 mesmo pra token desconhecido
});

// ── O servidor MCP ──────────────────────────────────────────────────────────
function recusar401(res, descricao) {
  const meta = `${cfg.issuer}/.well-known/oauth-protected-resource`;
  const extra = descricao ? `, error="invalid_token", error_description="${descricao}"` : '';
  res.set('WWW-Authenticate', `Bearer resource_metadata="${meta}", scope="${cfg.ESCOPO_LEITURA}"${extra}`);
  return res.status(401).json({ error: 'invalid_token', error_description: descricao || 'Conecte sua conta da Sora.' });
}

const SEM_ACESSO = {
  desligada: 'A conexão da Sora com o ChatGPT está desligada no momento.',
  teste: 'A Sora no ChatGPT ainda está em teste fechado e esta conta não faz parte dele.',
  plano: 'A Sora no ChatGPT faz parte dos planos Premium e Platinum. O plano desta conta não inclui. A pessoa pode ver os planos no painel da Sora (forsora.com).',
};

const INSTRUCOES = [
  'Estas ferramentas leem os dados financeiros que a pessoa organiza na Sora (forsora.com): transações, contas, cartões, faturas, dívidas, metas, contas fixas, investimentos e limites.',
  'Use as ferramentas em vez de supor números. Os valores vêm na moeda indicada em `moeda` (normalmente BRL).',
  'Aqui é só leitura: para lançar, corrigir ou apagar algo, a pessoa usa o painel ou o WhatsApp da Sora.',
  'Os totais do resumo deixam de fora transferências entre contas, pagamento de fatura e ajuste de saldo — não são ganho nem gasto.',
  'Os dados são do grupo ativo da pessoa na Sora; em gestão compartilhada, incluem os lançamentos das outras pessoas do grupo.',
].join(' ');

// Teto de chamadas por conexão (janela deslizante de 1 minuto, em memória).
const janelas = new Map();
function estourou(conexaoId, agora = Date.now()) {
  const lista = (janelas.get(conexaoId) || []).filter((t) => agora - t < 60_000);
  lista.push(agora);
  janelas.set(conexaoId, lista);
  if (janelas.size > 5000) janelas.clear();
  return lista.length > cfg.CHAMADAS_POR_MINUTO;
}

const erroFerramenta = (texto) => ({ isError: true, content: [{ type: 'text', text: texto }] });

function criarServidor({ acesso, usuario, pode, moeda }) {
  const server = new Server(
    { name: 'sora', title: 'Sora', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: INSTRUCOES },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: descritores(cfg.ESCOPO_LEITURA) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const nome = req.params?.name;
    const f = porNome[nome];
    if (!f) return erroFerramenta(`Ferramenta desconhecida: ${nome}.`);
    if (!pode.ok) return erroFerramenta(SEM_ACESSO[pode.motivo] || SEM_ACESSO.plano);
    if (!String(acesso.escopo || '').split(' ').includes(cfg.ESCOPO_LEITURA)) return erroFerramenta('Esta conexão não tem permissão de leitura.');
    if (estourou(acesso.conexaoId)) return erroFerramenta('Muitas consultas seguidas. Espere um minuto e tente de novo.');

    const hoje = hojeSP();
    const ctx = {
      get: (caminho) => getInterno(usuario.id, caminho),
      hoje, mesAtual: hoje.slice(0, 7), moeda,
    };
    const t0 = Date.now();
    let ok = false;
    try {
      const dados = await f.executar(ctx, req.params?.arguments || {});
      ok = true;
      return { content: [{ type: 'text', text: JSON.stringify(dados) }], structuredContent: dados };
    } catch (e) {
      if (e instanceof ErroFerramenta) return erroFerramenta(e.message);
      console.error(`[ia] ${nome}:`, e.message);
      return erroFerramenta('A Sora não conseguiu responder agora. Tente de novo em instantes.');
    } finally {
      oauth.registrarUso(supabase, { conexaoId: acesso.conexaoId, userId: usuario.id, ferramenta: nome, ok, ms: Date.now() - t0 });
    }
  });
  return server;
}

router.post('/mcp', async (req, res) => {
  try {
    if (!cfg.ativa()) return recusar401(res, 'Conexão desligada.');
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
    if (!token) return recusar401(res);
    const acesso = await oauth.validarAcesso(supabase, token);
    if (!acesso) return recusar401(res, 'Token inválido ou vencido.');

    const { data: usuario } = await supabase.from('users')
      .select('id, email, plano, plano_valido_ate, grupo_ativo').eq('id', acesso.userId).maybeSingle();
    if (!usuario) return recusar401(res, 'Conta não encontrada.');
    // Plano que venceu ou saiu do teste: a conexão continua, mas as
    // ferramentas explicam por que não respondem (o ChatGPT repassa à pessoa).
    const pode = cfg.acessoIa(usuario);
    let moeda = 'BRL';
    try { if (usuario.grupo_ativo) moeda = (await moedaBaseDoGrupo(usuario.grupo_ativo)) || 'BRL'; } catch { /* BRL */ }

    const server = criarServidor({ acesso, usuario, pode, moeda });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[ia] /mcp:', e.message);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erro interno.' }, id: null });
  }
});

// Sem sessão: não há fluxo SSE pra abrir nem sessão pra encerrar.
const semSessao = (req, res) => res.status(405).set('Allow', 'POST')
  .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método não permitido.' }, id: null });
router.get('/mcp', semSessao);
router.delete('/mcp', semSessao);

// ── Painel (JWT da pessoa) ──────────────────────────────────────────────────
async function linhaDoUsuario(userId) {
  const { data } = await supabase.from('users')
    .select('id, email, plano, plano_valido_ate, grupo_ativo').eq('id', userId).maybeSingle();
  return data;
}

// Os parâmetros do ChatGPT chegam na URL da tela e são repassados como estão.
const CAMPOS_PEDIDO = ['response_type', 'client_id', 'redirect_uri', 'code_challenge',
  'code_challenge_method', 'scope', 'state', 'resource'];
const doPedido = (src) => Object.fromEntries(CAMPOS_PEDIDO
  .filter((k) => typeof src?.[k] === 'string').map((k) => [k, src[k]]));

router.get('/api/ia-conectada/pedido', auth, async (req, res) => {
  try {
    const pedido = await oauth.validarPedido(doPedido(req.query));
    if (!pedido.ok) {
      return res.status(400).json({
        ok: false, erro: pedido.erro, descricao: pedido.descricao,
        // Só devolve pra onde voltar quando o endereço já foi conferido.
        voltar: pedido.redirecionar ? oauth.urlRetorno(pedido.redirect_uri, {
          error: pedido.erro, error_description: pedido.descricao, state: pedido.state,
        }) : null,
      });
    }
    const usuario = await linhaDoUsuario(req.authUser.id);
    res.json({
      ok: true,
      cliente: { nome: pedido.cliente.nome, logo: pedido.cliente.logo, host: pedido.cliente.host },
      escopo: pedido.escopo,
      acesso: cfg.acessoIa(usuario),
      email: usuario?.email || null,
    });
  } catch (e) {
    console.error('[ia] pedido:', e.message);
    res.status(500).json({ ok: false, erro: 'server_error', descricao: 'Não consegui conferir o pedido agora.' });
  }
});

router.post('/api/ia-conectada/aprovar', auth, async (req, res) => {
  try {
    // Confere TUDO de novo: a tela é só a tela.
    const pedido = await oauth.validarPedido(doPedido(req.body));
    if (!pedido.ok) return res.status(400).json({ ok: false, erro: pedido.erro, descricao: pedido.descricao });
    const usuario = await linhaDoUsuario(req.authUser.id);
    const pode = cfg.acessoIa(usuario);
    if (!pode.ok) return res.status(403).json({ ok: false, erro: 'sem_acesso', motivo: pode.motivo });
    const url = await oauth.aprovar(supabase, { userId: req.authUser.id, pedido });
    res.json({ ok: true, url });
  } catch (e) {
    console.error('[ia] aprovar:', e.message);
    res.status(500).json({ ok: false, erro: 'server_error', descricao: 'Não consegui concluir a conexão. Tente de novo.' });
  }
});

router.post('/api/ia-conectada/negar', auth, async (req, res) => {
  try {
    const pedido = await oauth.validarPedido(doPedido(req.body));
    if (!pedido.ok) return res.json({ ok: true, url: null });
    res.json({ ok: true, url: oauth.negar(pedido) });
  } catch (e) {
    res.json({ ok: true, url: null });
  }
});

router.get('/api/ia-conectada/conexoes', auth, async (req, res) => {
  try {
    const usuario = await linhaDoUsuario(req.authUser.id);
    const [cx, ac] = await Promise.all([
      supabase.from('ia_conexoes')
        .select('id, cliente_nome, escopo, criada_em, ultimo_uso_em')
        .eq('user_id', req.authUser.id).is('revogada_em', null)
        .gt('refresh_expira_em', new Date().toISOString())
        .order('criada_em', { ascending: false }),
      supabase.from('ia_acessos')
        .select('ferramenta, ok, criado_em, conexao_id')
        .eq('user_id', req.authUser.id).order('criado_em', { ascending: false }).limit(30),
    ]);
    // Sem a migration 197: a aba diz "em preparação" em vez de quebrar.
    const faltaMigration = !!(cx.error && /ia_conexoes|relation|does not exist|schema cache/i.test(cx.error.message));
    if (cx.error && !faltaMigration) throw cx.error;
    res.json({
      acesso: cfg.acessoIa(usuario),
      url_mcp: cfg.recurso,
      pronto: !faltaMigration,
      conexoes: cx.data || [],
      consultas: ac.error ? [] : (ac.data || []),
    });
  } catch (e) {
    console.error('[ia] conexoes:', e.message);
    res.status(500).json({ erro: 'Não consegui carregar suas conexões agora.' });
  }
});

router.delete('/api/ia-conectada/conexoes/:id', auth, async (req, res) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ erro: 'Conexão inválida.' });
    const ok = await oauth.revogar(supabase, { conexaoId: req.params.id, userId: req.authUser.id });
    res.json({ ok: true, revogada: ok });
  } catch (e) {
    console.error('[ia] revogar:', e.message);
    res.status(500).json({ erro: 'Não consegui desconectar agora. Tente de novo.' });
  }
});

module.exports = router;
