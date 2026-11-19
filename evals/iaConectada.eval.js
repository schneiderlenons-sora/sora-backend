// =============================================================================
// EVAL da Sora no ChatGPT — OAuth, chamada interna, ferramentas e o /mcp.
//
// Isto é CONTROLE DE ACESSO a dado financeiro. O erro aqui não aparece como
// número torto: aparece como o ChatGPT de uma pessoa lendo a conta de outra,
// um código roubado virando acesso, ou uma rota de escrita aberta a um token
// que só devia ler. Por isso cada trava tem o caso que PASSA e o que BARRA.
//
// O §9 sobe o roteador DE VERDADE (com o `auth` de verdade) numa porta local
// e conversa com ele como o ChatGPT conversa: initialize → tools/list →
// tools/call, com a ferramenta indo por loopback até uma rota de leitura.
//
// Rodar:  npm run eval:ia-conectada
// =============================================================================
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const falhas = [];
let casos = 0;
const ok = (c, m) => { casos++; if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// ── Banco falso (o pedaço do supabase-js que o código usa) ──────────────────
function bancoFake(inicial = {}) {
  const t = { ia_conexoes: [], ia_oauth_codigos: [], ia_acessos: [], users: [], ...inicial };
  let seq = 0;
  return {
    t,
    // Um token que não é JWT do Supabase: o Auth recusa (como o de verdade).
    auth: { getUser: async () => ({ data: { user: null }, error: new Error('invalid JWT') }) },
    from(nome) {
      const filtros = []; let op = 'select'; let valores = null; let lim = null; let devolver = false;
      const linhas = () => (t[nome] = t[nome] || []).filter((r) => filtros.every((f) => f(r)));
      const exec = () => {
        if (op === 'insert') {
          const lista = (Array.isArray(valores) ? valores : [valores]).map((v) => ({
            ...(nome === 'ia_conexoes' ? { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, revogada_em: null, criada_em: new Date().toISOString() } : {}),
            ...(nome === 'ia_oauth_codigos' ? { usado_em: null, conexao_id: null } : {}),
            ...v,
          }));
          // unique: codigo_hash, access_hash, refresh_hash
          for (const v of lista) t[nome].push(v);
          return { data: devolver ? lista : null, error: null };
        }
        if (op === 'update') {
          const alvo = linhas();
          for (const r of alvo) Object.assign(r, valores);
          return { data: devolver ? alvo.map((r) => ({ ...r })) : null, error: null };
        }
        let rs = linhas().map((r) => ({ ...r }));
        if (lim) rs = rs.slice(0, lim);
        return { data: rs, error: null };
      };
      const api = {
        select() { if (op !== 'select') devolver = true; return api; },
        insert(v) { op = 'insert'; valores = v; return api; },
        update(v) { op = 'update'; valores = v; return api; },
        eq(c, v) { filtros.push((r) => r[c] === v); return api; },
        is(c, v) { filtros.push((r) => (r[c] ?? null) === v); return api; },
        gt(c, v) { filtros.push((r) => r[c] > v); return api; },
        in(c, v) { filtros.push((r) => v.includes(r[c])); return api; },
        order() { return api; },
        limit(n) { lim = n; return api; },
        maybeSingle() { const r = exec(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: r.error }); },
        single() { const r = exec(); const d = Array.isArray(r.data) ? r.data[0] : r.data; return Promise.resolve({ data: d || null, error: d ? null : new Error('sem linha') }); },
        then(res, rej) { return Promise.resolve(exec()).then(res, rej); },
      };
      return api;
    },
  };
}

const raiz = path.resolve(__dirname, '../src');
const cfg = require(path.join(raiz, 'config/iaConectada.js'));
const interna = require(path.join(raiz, 'services/chamadaInterna.js'));
const oauth = require(path.join(raiz, 'services/oauthIa.js'));
const ferr = require(path.join(raiz, 'services/ferramentasIa.js'));

const DOC_CHATGPT = {
  client_id: 'https://chatgpt.com/oauth/client.json', client_name: 'ChatGPT',
  redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect', 'https://evil.example/cb'],
  logo_uri: 'https://persistent.oaistatic.com/x.png',
};
// O documento real do Claude (conferido em 18/11/2026) + um retorno pro
// chatgpt.com plantado, que tem de ser descartado (domínio de OUTRO cliente).
const DOC_CLAUDE = {
  client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', client_name: 'Claude',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect'],
  token_endpoint_auth_method: 'none',
};
const DOCS = { [DOC_CHATGPT.client_id]: DOC_CHATGPT, [DOC_CLAUDE.client_id]: DOC_CLAUDE };
const buscarOk = async (url) => ({ ok: true, json: async () => (DOCS[url] || { client_id: url, redirect_uris: ['https://evil.example/cb'] }) });
// O claude.ai responde ao Render com o desafio do Cloudflare (HTML, 403).
const buscarCloudflare = async () => ({ ok: false, status: 403, json: async () => { throw new Error('html'); } });
const buscarFora = async () => { throw new Error('rede'); };

const verifier = crypto.randomBytes(40).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const pedidoBase = {
  response_type: 'code', client_id: DOC_CHATGPT.client_id, redirect_uri: REDIRECT,
  code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: cfg.recurso,
  scope: 'financas:ler',
};
const USER = '11111111-1111-4111-8111-111111111111';
const OUTRO = '22222222-2222-4222-8222-222222222222';

(async () => {
  // ── §1 Chamada interna (a porta pela qual a ferramenta lê a rota) ─────────
  {
    const segredo = crypto.randomBytes(32);
    const caminho = '/api/dashboard/eu?mes=2026-11';
    const h = interna.assinar({ userId: USER, caminho, segredo });
    const req = (over = {}) => ({ method: 'GET', originalUrl: caminho, headers: { [interna.CABECALHO]: h }, socket: { remoteAddress: '127.0.0.1' }, ...over });
    eq(interna.verificar(req(), { segredo }), { userId: USER }, '§1 assinatura válida passa');
    eq(interna.verificar(req({ method: 'POST' }), { segredo }), null, '§1 POST nunca passa (só leitura)');
    eq(interna.verificar(req({ originalUrl: '/api/dashboard/eu?mes=2026-10' }), { segredo }), null, '§1 outro caminho não passa');
    eq(interna.verificar(req({ socket: { remoteAddress: '10.0.0.5' } }), { segredo }), null, '§1 de fora do loopback não passa');
    eq(interna.verificar(req(), { segredo: crypto.randomBytes(32) }), null, '§1 outro segredo (outro processo) não passa');
    eq(interna.verificar(req(), { segredo, agora: Date.now() + 31_000 }), null, '§1 vencida não passa');
    const trocado = h.replace(USER, OUTRO);
    eq(interna.verificar(req({ headers: { [interna.CABECALHO]: trocado } }), { segredo }), null, '§1 trocar o usuário invalida');
    eq(interna.verificar(req({ headers: {} }), { segredo }), null, '§1 sem cabeçalho → fluxo normal');
    eq(interna.verificar(req({ headers: { [interna.CABECALHO]: 'lixo' } }), { segredo }), null, '§1 lixo não passa');
  }

  // ── §2 PKCE e endereço de retorno ─────────────────────────────────────────
  ok(oauth.pkceConfere(verifier, challenge), '§2 PKCE certo confere');
  ok(!oauth.pkceConfere(verifier + 'a', challenge), '§2 verifier errado não confere');
  ok(!oauth.pkceConfere('curto', challenge), '§2 verifier curto demais não confere');
  const O_GPT = ['https://chatgpt.com'];
  ok(oauth.retornoAceito(REDIRECT, O_GPT), '§2 retorno do ChatGPT aceito');
  ok(!oauth.retornoAceito('https://evil.example/cb', O_GPT), '§2 retorno de outro host recusado');
  ok(!oauth.retornoAceito('http://chatgpt.com/x', O_GPT), '§2 http recusado');
  ok(!oauth.retornoAceito('https://chatgpt.com.evil.example/x', O_GPT), '§2 sufixo enganoso recusado');
  ok(!oauth.retornoAceito('https://claude.ai/api/mcp/auth_callback', O_GPT), '§2 domínio de outro cliente recusado');
  ok(!oauth.retornoAceito(REDIRECT), '§2 sem lista de domínios, nada passa');
  eq(cfg.clienteDoId('https://claude.ai/oauth/claude-code-client-metadata'), null, '§2 Claude Code (localhost) fica de fora');
  eq(cfg.clienteDoId('https://claude.ai/oauth/mcp-oauth-client-metadata?x=1'), null, '§2 id do Claude com sufixo não casa');

  // ── §3 Pedido de autorização ──────────────────────────────────────────────
  {
    oauth._limparCaches();
    const v = await oauth.validarPedido(pedidoBase, { buscar: buscarOk });
    ok(v.ok, '§3 pedido certo do ChatGPT é aceito');
    eq(v.cliente?.nome, 'ChatGPT', '§3 nome vem do documento da OpenAI');
    eq(v.escopo, 'financas:ler', '§3 escopo de leitura');
    eq(v.state, 'xyz', '§3 state repassado');

    oauth._limparCaches();
    const evil = await oauth.validarPedido({ ...pedidoBase, client_id: 'https://evil.example/client.json' }, { buscar: buscarOk });
    ok(!evil.ok && evil.redirecionar === false, '§3 cliente fora da lista: erro SEM redirecionar');

    oauth._limparCaches();
    const evilRet = await oauth.validarPedido({ ...pedidoBase, redirect_uri: 'https://evil.example/cb' }, { buscar: buscarOk });
    ok(!evilRet.ok && evilRet.redirecionar === false, '§3 retorno fora de chatgpt.com recusado mesmo listado no documento');

    oauth._limparCaches();
    const semPkce = await oauth.validarPedido({ ...pedidoBase, code_challenge_method: 'plain' }, { buscar: buscarOk });
    ok(!semPkce.ok && semPkce.redirecionar === true && semPkce.erro === 'invalid_request', '§3 sem S256: erro volta pro ChatGPT');

    const outroRecurso = await oauth.validarPedido({ ...pedidoBase, resource: 'https://outro/mcp' }, { buscar: buscarOk });
    eq(outroRecurso.erro, 'invalid_target', '§3 recurso de outro servidor recusado');

    const tipo = await oauth.validarPedido({ ...pedidoBase, response_type: 'token' }, { buscar: buscarOk });
    eq(tipo.erro, 'unsupported_response_type', '§3 fluxo implícito recusado');

    const semEscopo = await oauth.validarPedido({ ...pedidoBase, scope: 'openid email' }, { buscar: buscarOk });
    eq(semEscopo.escopo, 'financas:ler', '§3 escopo desconhecido cai na leitura (não amplia nada)');

    oauth._limparCaches();
    const offline = await oauth.validarPedido(pedidoBase, { buscar: buscarFora });
    ok(offline.ok, '§3 OpenAI fora do ar: o ChatGPT conhecido segue conectando');

    const url = new URL(oauth.urlRetorno(REDIRECT, { code: 'c', state: 's' }));
    eq(url.searchParams.get('iss'), cfg.issuer, '§3 resposta leva `iss` igual ao emissor (RFC 9207)');

    // Claude
    const CLAUDE_RET = 'https://claude.ai/api/mcp/auth_callback';
    const pedidoClaude = { ...pedidoBase, client_id: DOC_CLAUDE.client_id, redirect_uri: CLAUDE_RET };
    delete pedidoClaude.resource;   // o Claude não manda `resource`
    oauth._limparCaches();
    const cl = await oauth.validarPedido(pedidoClaude, { buscar: buscarOk });
    ok(cl.ok, '§3 pedido do Claude (sem `resource`) é aceito');
    eq([cl.cliente?.nome, cl.cliente?.empresa, cl.cliente?.chave], ['Claude', 'Anthropic', 'claude'], '§3 Claude identificado (nome, empresa)');
    eq(cl.recurso, cfg.recurso, '§3 sem `resource`, o token sai pra este /mcp');
    oauth._limparCaches();
    const clCruzado = await oauth.validarPedido({ ...pedidoClaude, redirect_uri: REDIRECT }, { buscar: buscarOk });
    ok(!clCruzado.ok && clCruzado.redirecionar === false, '§3 documento do Claude não manda o código pro chatgpt.com');
    oauth._limparCaches();
    const gptCruzado = await oauth.validarPedido({ ...pedidoBase, redirect_uri: CLAUDE_RET }, { buscar: buscarOk });
    ok(!gptCruzado.ok && gptCruzado.redirecionar === false, '§3 id do ChatGPT não manda o código pro claude.ai');
    oauth._limparCaches();
    const clCf = await oauth.validarPedido(pedidoClaude, { buscar: buscarCloudflare });
    ok(clCf.ok, '§3 claude.ai barrado pelo Cloudflare: o Claude conhecido segue conectando');
    oauth._limparCaches();
    const clCom = await oauth.validarPedido({ ...pedidoClaude, redirect_uri: 'https://claude.com/api/mcp/auth_callback' }, { buscar: buscarCloudflare });
    ok(clCom.ok, '§3 retorno futuro em claude.com aceito');
  }

  // ── §4 Código → token ─────────────────────────────────────────────────────
  const db = bancoFake();
  oauth._limparCaches();
  const pedido = await oauth.validarPedido(pedidoBase, { buscar: buscarOk });
  const urlOk = new URL(await oauth.aprovar(db, { userId: USER, pedido }));
  const code = urlOk.searchParams.get('code');
  eq(urlOk.searchParams.get('state'), 'xyz', '§4 state volta');
  ok(code && !db.t.ia_oauth_codigos.some((r) => JSON.stringify(r).includes(code)), '§4 o código NÃO fica em texto no banco');

  const troca = (p) => oauth.trocarCodigo(db, { code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: DOC_CHATGPT.client_id, resource: cfg.recurso, ...p });
  const r1 = await troca({});
  ok(r1.corpo?.access_token?.startsWith('sora_at_') && r1.corpo?.refresh_token?.startsWith('sora_rt_'), '§4 troca certa emite access + refresh');
  eq(r1.corpo?.token_type, 'Bearer', '§4 token Bearer');
  ok(!JSON.stringify(db.t.ia_conexoes).includes(r1.corpo.access_token), '§4 token NÃO fica em texto no banco');

  const reuso = await troca({});
  eq(reuso.erro?.corpo?.error, 'invalid_grant', '§4 código reapresentado é recusado');
  ok(db.t.ia_conexoes.every((c) => c.revogada_em), '§4 …e derruba a conexão que ele gerou (código pode ter vazado)');

  // Código novo pra testar as outras recusas
  const novoCodigo = async () => new URL(await oauth.aprovar(db, { userId: USER, pedido })).searchParams.get('code');
  {
    const c = await novoCodigo();
    const r = await oauth.trocarCodigo(db, { code: c, code_verifier: crypto.randomBytes(40).toString('base64url'), redirect_uri: REDIRECT, client_id: DOC_CHATGPT.client_id });
    eq(r.erro?.corpo?.error, 'invalid_grant', '§4 PKCE errado recusado');
  }
  {
    const c = await novoCodigo();
    const r = await oauth.trocarCodigo(db, { code: c, code_verifier: verifier, redirect_uri: 'https://chatgpt.com/outro', client_id: DOC_CHATGPT.client_id });
    eq(r.erro?.corpo?.error, 'invalid_grant', '§4 retorno diferente do pedido recusado');
  }
  {
    const c = await novoCodigo();
    const r = await oauth.trocarCodigo(db, { code: c, code_verifier: verifier, redirect_uri: REDIRECT, client_id: DOC_CHATGPT.client_id }, { agora: Date.now() + 6 * 60_000 });
    eq(r.erro?.corpo?.error, 'invalid_grant', '§4 código vencido (5 min) recusado');
  }
  {
    const c = await novoCodigo();
    const r = await oauth.trocarCodigo(db, { code: c, code_verifier: verifier, redirect_uri: REDIRECT, client_id: 'https://chatgpt.com/oauth/abc/client.json' });
    eq(r.erro?.corpo?.error, 'invalid_grant', '§4 código de outro cliente recusado');
  }

  // Conexão válida pra seguir
  const c2 = await novoCodigo();
  const tok = (await oauth.trocarCodigo(db, { code: c2, code_verifier: verifier, redirect_uri: REDIRECT, client_id: DOC_CHATGPT.client_id, resource: cfg.recurso })).corpo;
  ok(!!tok?.access_token, '§4 conexão nova emitida');

  // Claude conecta ao lado (sem `resource` nem na troca) — e não derruba o ChatGPT.
  {
    oauth._limparCaches();
    const pc = await oauth.validarPedido({ ...pedidoBase, client_id: DOC_CLAUDE.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback', resource: undefined }, { buscar: buscarOk });
    const cc = new URL(await oauth.aprovar(db, { userId: USER, pedido: pc })).searchParams.get('code');
    const tc = await oauth.trocarCodigo(db, { code: cc, code_verifier: verifier, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_id: DOC_CLAUDE.client_id });
    ok(!!tc.corpo?.access_token, '§4 Claude: código vira token sem `resource`');
    oauth._limparCaches();
    ok(!!(await oauth.validarAcesso(db, tok.access_token)), '§4 conectar o Claude NÃO derruba o ChatGPT');
    eq((await oauth.validarAcesso(db, tc.corpo.access_token))?.cliente, 'Claude', '§4 token do Claude identifica o Claude');
    const cx = db.t.ia_conexoes.find((c) => c.cliente_nome === 'Claude' && !c.revogada_em);
    await oauth.revogar(db, { conexaoId: cx.id, userId: USER });
  }

  // ── §5 Token no /mcp ──────────────────────────────────────────────────────
  oauth._limparCaches();
  const a = await oauth.validarAcesso(db, tok.access_token);
  eq(a?.userId, USER, '§5 token válido identifica a pessoa');
  eq(await oauth.validarAcesso(db, r1.corpo.access_token), null, '§5 token da conexão derrubada não vale');
  eq(await oauth.validarAcesso(db, 'eyJhbGciOi.jwt.supabase'), null, '§5 JWT do Supabase não vale no /mcp');
  oauth._limparCaches();
  eq(await oauth.validarAcesso(db, tok.access_token, { agora: Date.now() + 61 * 60_000 }), null, '§5 access vencido (1 h) não vale');

  // ── §6 Renovação com rotação ──────────────────────────────────────────────
  const ren = await oauth.renovar(db, { refresh_token: tok.refresh_token, client_id: DOC_CHATGPT.client_id, resource: cfg.recurso });
  ok(!!ren.corpo?.refresh_token && ren.corpo.refresh_token !== tok.refresh_token, '§6 renovar troca o refresh (rotação)');
  oauth._limparCaches();
  eq(await oauth.validarAcesso(db, tok.access_token), null, '§6 o access antigo morre na rotação');
  ok(!!(await oauth.validarAcesso(db, ren.corpo.access_token)), '§6 o access novo vale');
  const graca = await oauth.renovar(db, { refresh_token: tok.refresh_token, client_id: DOC_CHATGPT.client_id });
  ok(!!graca.corpo?.access_token, '§6 refresh antigo vale na graça (resposta perdida na rede)');
  const tarde = await oauth.renovar(db, { refresh_token: tok.refresh_token, client_id: DOC_CHATGPT.client_id }, { agora: Date.now() + 6 * 60_000 });
  eq(tarde.erro?.corpo?.error, 'invalid_grant', '§6 refresh antigo depois da graça é recusado');
  const outroCli = await oauth.renovar(db, { refresh_token: graca.corpo.refresh_token, client_id: 'https://chatgpt.com/oauth/x/client.json' });
  eq(outroCli.erro?.corpo?.error, 'invalid_grant', '§6 refresh de outro cliente recusado');
  const vencido = await oauth.renovar(db, { refresh_token: graca.corpo.refresh_token, client_id: DOC_CHATGPT.client_id }, { agora: Date.now() + 61 * 86400_000 });
  eq(vencido.erro?.corpo?.error, 'invalid_grant', '§6 refresh com 60 dias parado recusado');

  // ── §7 Revogação ──────────────────────────────────────────────────────────
  {
    const vivo = graca.corpo;
    const conexao = db.t.ia_conexoes.find((c) => !c.revogada_em);
    ok(!(await oauth.revogar(db, { conexaoId: conexao.id, userId: OUTRO })), '§7 outra pessoa não desconecta a minha');
    ok(!!(await oauth.validarAcesso(db, vivo.access_token)), '§7 …e a minha continua de pé');
    ok(await oauth.revogar(db, { conexaoId: conexao.id, userId: USER }), '§7 eu desconecto a minha');
    eq(await oauth.validarAcesso(db, vivo.access_token), null, '§7 desconectada vale NA HORA (cache limpo)');
    const rr = await oauth.renovar(db, { refresh_token: vivo.refresh_token, client_id: DOC_CHATGPT.client_id });
    eq(rr.erro?.corpo?.error, 'invalid_grant', '§7 desconectada não renova');
  }

  // ── §8 Quem pode usar ─────────────────────────────────────────────────────
  {
    const antes = { ...process.env };
    delete process.env.IA_CONECTADA_ABERTA; delete process.env.IA_CONECTADA_ATIVA;
    eq(cfg.acessoIa({ email: 'comercialsora@gmail.com', plano: 'premium' }), { ok: true }, '§8 conta de teste premium entra');
    eq(cfg.acessoIa({ email: 'Comercialsora@Gmail.com ', plano: 'platinum' }), { ok: true }, '§8 e-mail com caixa/espaço diferente entra');
    eq(cfg.acessoIa({ email: 'cliente@x.com', plano: 'premium' }).motivo, 'teste', '§8 fora do teste fechado não entra');
    eq(cfg.acessoIa({ email: 'comercialsora@gmail.com', plano: 'basico' }).motivo, 'plano', '§8 Básico não entra');
    eq(cfg.acessoIa({ email: 'comercialsora@gmail.com', plano: 'kit' }).motivo, 'plano', '§8 Kit não entra');
    eq(cfg.acessoIa({ email: 'comercialsora@gmail.com', plano: 'black' }), { ok: true }, '§8 black legado = premium');
    eq(cfg.acessoIa({ email: 'comercialsora@gmail.com', plano: 'premium', plano_valido_ate: '2020-01-01' }).motivo, 'plano', '§8 plano vencido não entra');
    process.env.IA_CONECTADA_ABERTA = '1';
    eq(cfg.acessoIa({ email: 'cliente@x.com', plano: 'premium' }), { ok: true }, '§8 aberta: todo premium entra');
    eq(cfg.acessoIa({ email: 'cliente@x.com', plano: 'gratis' }).motivo, 'plano', '§8 aberta: grátis segue fora');
    process.env.IA_CONECTADA_ATIVA = '0';
    eq(cfg.acessoIa({ email: 'comercialsora@gmail.com', plano: 'premium' }).motivo, 'desligada', '§8 interruptor desliga tudo');
    process.env = antes;
  }

  // ── §9 Ferramentas (formato e regras canônicas) ───────────────────────────
  {
    const rotas = {
      '/api/transacoes/eu/resumo?mes=2026-11': { receitas: 5000, gastos: 3210.456, saldo: 1789.544,
        por_categoria: [{ categoria: 'Mercado', total: 800 }, { categoria: 'iFood', total: 120 }, { categoria: 'Alimentação', total: 300 }],
        por_categoria_receitas: [{ categoria: 'Salário', total: 5000 }],
        por_membro: [{ user_id: USER, name: 'Ana', phone: '5511999990000', gastos: 3000, receitas: 5000 }, { user_id: OUTRO, name: 'Bia', phone: '5511888880000', gastos: 210, receitas: 0 }] },
      '/api/transacoes/eu?mes=2026-11&limit=500': { total: 3, transacoes: [
        { id: 't1', data: '2026-11-10T00:00:00+00:00', observacao: 'Uber centro', valor: 25, tipo: 'Gasto', categoria: 'Uber', carteira_nome: 'Nubank', pago: true, criador: { name: 'Ana', phone: '5511999990000' } },
        { id: 't2', data: '2026-11-02T01:30:00+00:00', observacao: 'Pagamento fatura', valor: 900, tipo: 'Gasto', categoria: 'Fatura', transferencia: true, carteira_nome: 'Itaú' },
        { id: 't3', data: '2026-11-05T15:00:00+00:00', observacao: 'Salário', valor: 5000, tipo: 'Recebimento', categoria: 'Salário', carteira_nome: 'Itaú' },
      ] },
      '/api/wallets/faturas/eu?offset=0': { offset: 0, faturas: [
        { nome: 'Nubank', competencia: '2026-11', label: 'Fatura de novembro', ini: '2026-10-06', fim: '2026-11-05', venc: '2026-11-12', fatura: 1000, pago: 1000, restante: 0, quitada: true, fechada: true, of: true, proxima: { competencia: '2026-12', label: 'Fatura de dezembro', venc: '2026-12-12', restante: 345.67 } },
        { nome: 'C6', competencia: '2026-11', ini: '2026-10-20', fim: '2026-11-19', venc: '2026-11-28', fatura: 500, pago: 0, restante: 500, quitada: false, fechada: false, atrasadas: [{ competencia: '2026-10', venc: '2026-10-28', restante: 80 }] },
      ] },
      // ⚠️ Formato REAL da linha de `category_limits` (o teto é `limite_mensal`).
      // Com o formato inventado (`limite`), a ferramenta lia o campo errado e
      // este eval passava: o teto saía 0 pra todo cliente.
      '/api/limites/eu?mes=2026-11': { meta_mensal: 4000, meta_mensal_ativo: true,
        categorias: [
          { id: 'l1', grupo_id: 'g1', categoria: 'Alimentação', limite_mensal: 1000, mes_referencia: '2026-11', percentual_alerta: 80, ativo: true, periodo: 'mensal' },
          { id: 'l2', grupo_id: 'g1', categoria: 'Mercado', limite_mensal: 500, mes_referencia: '2026-11', percentual_alerta: 80, ativo: false, periodo: 'mensal' },
        ],
        categorias_ano: [{ id: 'l3', grupo_id: 'g1', categoria: 'Viagem', limite_mensal: 6000, mes_referencia: '2026', ativo: true, periodo: 'anual' }] },
      '/api/categorias/eu': [{ id: 'c1', nome: '🍔 Alimentação', parent_id: null, tipo: 'despesa' }, { id: 'c2', nome: 'iFood', parent_id: 'c1', tipo: 'despesa', parent: { nome: '🍔 Alimentação' } }, { id: 'c3', nome: 'Mercado', parent_id: null, tipo: 'despesa' }],
      '/api/investimentos/eu': { __status: 403, erro: 'Esta funcionalidade exige plano' },
    };
    const ctx = {
      hoje: '2026-11-18', mesAtual: '2026-11', moeda: 'BRL',
      get: async (c) => {
        const r = rotas[c];
        if (!r) return { status: 404, json: { erro: 'x' } };
        if (r.__status) return { status: r.__status, json: r };
        return { status: 200, json: r };
      },
    };
    const res = await ferr.porNome.resumo_do_mes.executar(ctx, {});
    eq(res.despesas, 3210.46, '§9 resumo: número do painel, arredondado ao centavo');
    eq(res.por_pessoa?.length, 2, '§9 resumo: por pessoa em gestão compartilhada');
    ok(!JSON.stringify(res).includes('5511'), '§9 resumo: telefone de membro NUNCA sai');

    const tx = await ferr.porNome.listar_transacoes.executar(ctx, { busca: 'uber' });
    eq(tx.transacoes.map((x) => x.descricao), ['Uber centro'], '§9 transações: busca por trecho');
    ok(tx.transacoes.every((x) => !('id' in x)), '§9 transações: sem id interno (minimização de dado)');
    ok(!JSON.stringify(tx).includes('5511'), '§9 transações: telefone de quem lançou NUNCA sai');
    const todas = await ferr.porNome.listar_transacoes.executar(ctx, {});
    eq(todas.transacoes.find((x) => x.descricao === 'Pagamento fatura').entra_no_resumo, false, '§9 pagamento de fatura marcado fora do resumo (ehTransferencia)');
    eq(todas.transacoes.find((x) => x.descricao === 'Uber centro').data, '2026-11-10', '§9 meia-noite UTC = data pura');
    eq(todas.transacoes.find((x) => x.descricao === 'Pagamento fatura').data, '2026-11-01', '§9 01:30 UTC = dia anterior em São Paulo');
    eq((await ferr.porNome.listar_transacoes.executar(ctx, { conta: 'itau' })).transacoes.length, 2, '§9 filtro de conta sem acento');

    const fat = await ferr.porNome.faturas_dos_cartoes.executar(ctx, {});
    eq(fat.faturas[0].valor_mostrado_no_painel, 345.67, '§9 fatura fechada e paga: vale a próxima (regra do Dashboard)');
    eq(fat.faturas[1].valor_mostrado_no_painel, 500, '§9 fatura em aberto: o restante');
    eq(fat.faturas[1].atrasadas?.[0]?.falta_pagar, 80, '§9 fatura atrasada aparece');

    const lim = await ferr.porNome.limites_de_gastos.executar(ctx, {});
    eq(lim.por_categoria[0].gasto, 420, '§9 limite da categoria-pai soma a subcategoria (nomesDoLimite): 300 + 120');
    eq(lim.por_categoria[0].teto, 1000, '§9 o teto vem de limite_mensal (não sai 0)');
    eq(lim.por_categoria[0].usado_pct, 42, '§9 percentual usado = gasto / teto');
    eq(lim.por_categoria.length, 1, '§9 limite pausado fica de fora');
    eq(lim.tetos_anuais?.[0]?.teto_do_ano, 6000, '§9 teto anual também vem de limite_mensal');
    eq(lim.limite_geral?.gasto, 3210.46, '§9 limite geral = despesas do resumo');

    let erroPlano = null;
    try { await ferr.porNome.investimentos.executar(ctx, {}); } catch (e) { erroPlano = e; }
    ok(erroPlano instanceof ferr.ErroFerramenta, '§9 403 da rota vira explicação, não falha');

    let erroMes = null;
    try { await ferr.porNome.resumo_do_mes.executar(ctx, { mes: '11/2026' }); } catch (e) { erroMes = e; }
    ok(erroMes instanceof ferr.ErroFerramenta, '§9 mês em formato errado é recusado com explicação');

    const desc = ferr.descritores('financas:ler');
    ok(desc.every((d) => d.annotations.readOnlyHint === true && d.annotations.destructiveHint === false), '§9 toda ferramenta é marcada só-leitura');
    ok(desc.every((d) => d.securitySchemes?.[0]?.type === 'oauth2'), '§9 toda ferramenta exige OAuth');
    eq(ferr.FERRAMENTAS.length, 11, '§9 11 ferramentas na fase 1');
    // Nenhuma ferramenta pode chamar rota de escrita: só GET por construção
    // (ctx.get), mas o texto do arquivo também não pode citar outro verbo.
    const fonte = require('fs').readFileSync(path.join(raiz, 'services/ferramentasIa.js'), 'utf8');
    ok(!/method:\s*['"](POST|PUT|PATCH|DELETE)/i.test(fonte), '§9 ferramentas não fazem POST/PUT/DELETE');
  }

  // ── §10 O /mcp de verdade, por HTTP, com o `auth` de verdade ──────────────
  {
    const dbHttp = bancoFake({ users: [{ id: USER, email: 'comercialsora@gmail.com', phone: '5511999990000', grupo_ativo: 'g1', plano: 'premium', plano_valido_ate: null }] });
    const f = path.join(raiz, 'db/supabase.js');
    require.cache[f] = { id: f, filename: f, loaded: true, exports: dbHttp };
    for (const k of Object.keys(require.cache)) {
      if (k.includes(`${path.sep}src${path.sep}`) && !k.endsWith(`db${path.sep}supabase.js`)) delete require.cache[k];
    }
    // A moeda do grupo não interessa aqui.
    const moedaPath = path.join(raiz, 'services/moeda.js');
    require.cache[moedaPath] = { id: moedaPath, filename: moedaPath, loaded: true, exports: { moedaBaseDoGrupo: async () => 'BRL' } };

    const express = require('express');
    const app = express();
    app.use(express.json());
    const auth = require(path.join(raiz, 'middlewares/auth.js'));
    let vistoPor = null;
    // Rota de leitura de mentira ATRÁS do `auth` real: é ele que tem de
    // aceitar a assinatura interna e amarrar ao usuário certo.
    app.get('/api/transacoes/:phone/resumo', auth, (req, res) => {
      vistoPor = { id: req.authUser.id, phone: req.params.phone };
      res.json({ receitas: 10, gastos: 4, saldo: 6, por_categoria: [], por_categoria_receitas: [], por_membro: [] });
    });
    app.post('/api/escrita', auth, (req, res) => res.json({ escreveu: true }));
    app.use(require(path.join(raiz, 'routes/mcp.js')));
    const srv = http.createServer(app);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const porta = srv.address().port;
    process.env.PORT = String(porta);
    const base = `http://127.0.0.1:${porta}`;

    const oauthHttp = require(path.join(raiz, 'services/oauthIa.js'));
    oauthHttp._limparCaches();
    const ped = await oauthHttp.validarPedido(pedidoBase, { buscar: buscarOk });
    const cod = new URL(await oauthHttp.aprovar(dbHttp, { userId: USER, pedido: ped })).searchParams.get('code');

    const form = (o) => new URLSearchParams(o).toString();
    const rt = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'authorization_code', code: cod, code_verifier: verifier, redirect_uri: REDIRECT, client_id: DOC_CHATGPT.client_id, resource: cfg.recurso }) });
    const tk = await rt.json();
    eq(rt.status, 200, '§10 /oauth/token por formulário responde 200');
    eq(rt.headers.get('cache-control'), 'no-store', '§10 resposta de token sem cache');

    const rpc = (corpo, token = tk.access_token) => fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(corpo),
    });

    const semToken = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, null);
    eq(semToken.status, 401, '§10 /mcp sem token: 401');
    ok((semToken.headers.get('www-authenticate') || '').includes('resource_metadata='), '§10 401 aponta os metadados (o ChatGPT descobre o login por aqui)');

    const ini = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eval', version: '1' } } });
    const iniJ = await ini.json();
    eq(ini.status, 200, '§10 initialize 200');
    eq([iniJ.result?.serverInfo?.name, iniJ.result?.serverInfo?.title], ['forsora', 'ForSora'], '§10 servidor se apresenta como ForSora (Sora é o app de vídeo da OpenAI)');

    const lista = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })).json();
    eq(lista.result?.tools?.length, 11, '§10 tools/list traz as 11');
    ok(lista.result?.tools?.every((t) => Array.isArray(t.securitySchemes) && Array.isArray(t._meta?.securitySchemes)), '§10 securitySchemes chega no descritor (no topo e no _meta)');

    const call = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'resumo_do_mes', arguments: { mes: '2026-11' } } })).json();
    eq(call.result?.structuredContent?.resultado, 6, '§10 tools/call lê a rota por loopback e devolve o número dela');
    eq(vistoPor, { id: USER, phone: '5511999990000' }, '§10 a rota viu A PESSOA certa (auth real, telefone dela)');
    await new Promise((r) => setTimeout(r, 30));
    ok(dbHttp.t.ia_acessos.some((x) => x.ferramenta === 'resumo_do_mes' && x.ok), '§10 a consulta fica registrada pra aba "ChatGPT"');

    // O token do ChatGPT NÃO abre as rotas do painel.
    const direto = await fetch(`${base}/api/escrita`, { method: 'POST', headers: { authorization: `Bearer ${tk.access_token}`, 'content-type': 'application/json' }, body: '{}' });
    ok(direto.status === 401, '§10 token do ChatGPT recusado numa rota de escrita do painel');
    const diretoGet = await fetch(`${base}/api/transacoes/eu/resumo`, { headers: { authorization: `Bearer ${tk.access_token}` } });
    ok(diretoGet.status === 401, '§10 …e numa rota de leitura também (só vale no /mcp)');

    // Plano que venceu: a conexão segue, a ferramenta explica.
    dbHttp.t.users[0].plano = 'basico';
    const semPlano = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'resumo_do_mes', arguments: {} } })).json();
    ok(semPlano.result?.isError && !!semPlano.result.content[0].text, '§10 sem plano: a ferramenta explica (o ChatGPT repassa)');
    ok(!/premium|platinum|planos?|upgrade|assin/i.test(semPlano.result.content[0].text), '§10 sem plano: NÃO fala de planos nem de upgrade (diretriz do ChatGPT)');
    const desafio = await fetch(`${base}/.well-known/openai-apps-challenge`);
    eq(desafio.status, 404, '§10 verificação de domínio: 404 sem a variável');
    process.env.OPENAI_APPS_CHALLENGE = 'abc123';
    const desafio2 = await fetch(`${base}/.well-known/openai-apps-challenge`);
    eq([desafio2.status, await desafio2.text()], [200, 'abc123'], '§10 verificação de domínio: devolve o texto puro');
    delete process.env.OPENAI_APPS_CHALLENGE;
    dbHttp.t.users[0].plano = 'premium';

    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    eq(meta.issuer, cfg.issuer, '§10 metadados: emissor');
    ok(meta.code_challenge_methods_supported.includes('S256') && meta.client_id_metadata_document_supported === true, '§10 metadados: S256 + CIMD');
    ok(!('registration_endpoint' in meta), '§10 sem cadastro aberto de cliente');
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    eq(pr.resource, cfg.recurso, '§10 recurso protegido = /mcp');
    eq(pr.authorization_servers, [cfg.issuer], '§10 emissor bate com o da autorização');

    srv.close();
  }

  if (falhas.length) {
    console.log(`✗ ${falhas.length} de ${casos} falharam:\n - ` + falhas.join('\n - '));
    process.exit(1);
  }
  console.log(`✓ Sora no ChatGPT/Claude: ${casos} casos (OAuth, chamada interna, ferramentas e /mcp por HTTP)`);
  process.exit(0);
})().catch((e) => { console.error('✗ eval quebrou:', e); process.exit(1); });
