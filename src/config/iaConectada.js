// ─────────────────────────────────────────────────────────────────────────────
// Sora no ChatGPT: o cliente conecta o ChatGPT DELE à Sora (servidor MCP).
//
// A conversa acontece no ChatGPT, na conta e no plano do cliente. A Sora não
// chama modelo nenhum aqui: só expõe ferramentas de LEITURA, e cada uma
// responde com a MESMA rota que o painel usa (ver services/chamadaInterna.js).
//
// ⚠️ ESPELHO de `sora-frontend/lib/ia-conectada.ts` (planos e lista de teste).
// Mexeu num, mexa no outro — `npm run eval:ia-conectada` no front compara.
// ─────────────────────────────────────────────────────────────────────────────
const { normalizarPlano } = require('./planos');

const semBarra = (u) => String(u || '').replace(/\/+$/, '');

// ⚠️ O ENDEREÇO FICA GRAVADO NO CHATGPT DE CADA CLIENTE. Trocar depois derruba
// todas as conexões (cada um teria de conectar de novo). Antes de abrir pra
// clientes, apontar `MCP_BASE_URL` pra um domínio próprio (ex.:
// https://mcp.forsora.com) — a troca de região de nov/2026 mudou o endereço do
// backend, e um domínio próprio sobrevive a isso.
const BASE = semBarra(process.env.MCP_BASE_URL || 'https://sora-backend-ohio.onrender.com');

const config = {
  /** Emissor do OAuth. Tem de bater EXATAMENTE com o `iss` devolvido. */
  issuer: BASE,
  /** O recurso protegido (o servidor MCP). O ChatGPT manda isto em `resource` (o Claude não manda). */
  recurso: `${BASE}/mcp`,
  tokenEndpoint: `${BASE}/oauth/token`,
  revogarEndpoint: `${BASE}/oauth/revoke`,
  /** A tela de consentimento mora no site (a pessoa precisa estar logada lá). */
  autorizarUrl: semBarra(process.env.IA_AUTORIZAR_URL || 'https://www.forsora.com/oauth/autorizar'),
  politicaUrl: 'https://www.forsora.com/privacidade',
  termosUrl: 'https://www.forsora.com/termos',

  /** Fase 1: só leitura. */
  ESCOPO_LEITURA: 'financas:ler',
  escoposSuportados: ['financas:ler'],

  /** Validade dos tokens. O refresh roda a cada uso (rotação). */
  ACCESS_TTL_S: 60 * 60,              // 1 hora
  REFRESH_TTL_S: 60 * 24 * 60 * 60,   // 60 dias
  CODIGO_TTL_S: 5 * 60,               // código de autorização: 5 min, uso único
  /** Refresh antigo ainda aceito logo depois da rotação (resposta perdida na rede). */
  REFRESH_GRACA_S: 5 * 60,

  /** Teto de chamadas de ferramenta por conexão (proteção do backend e do egress). */
  CHAMADAS_POR_MINUTO: 60,
};

// ── Quem é cliente OAuth aceito ─────────────────────────────────────────────
// ChatGPT e Claude (decisão do dono, nov/2026). O cliente se identifica por
// URL (Client ID Metadata Document): o `client_id` é o endereço de um JSON
// publicado pela OpenAI / pela Anthropic, e é dele que saem nome e endereços
// de retorno.
//
// Aceitar QUALQUER URL seria abrir a porta pra um "app" que se apresenta como
// "ChatGPT" na tela de consentimento e devolve o código pra outro lugar. Por
// isso cada cliente tem o id da EMPRESA dele e só pode voltar pros domínios
// DELA — o documento do ChatGPT não consegue mandar o código pro claude.ai e
// vice-versa.
//
// ⚠️ Claude Code (o da linha de comando) fica de fora: ele volta pra
// `localhost`, onde qualquer programa do computador escuta. É ferramenta de
// desenvolvedor, não o app que o cliente usa.
const CLIENTES = [
  {
    chave: 'chatgpt', nome: 'ChatGPT', empresa: 'OpenAI',
    id: /^https:\/\/chatgpt\.com\/oauth\/(?:[A-Za-z0-9_-]{1,80}\/)?client\.json$/,
    origens: ['https://chatgpt.com'],
  },
  {
    // https://claude.com/docs/connectors/building/authentication — o Claude
    // usa CIMD quando o servidor anuncia `client_id_metadata_document_supported`
    // e `none` (é o nosso caso). O documento: client_name "Claude",
    // retorno https://claude.ai/api/mcp/auth_callback (conferido em 18/11/2026).
    chave: 'claude', nome: 'Claude', empresa: 'Anthropic',
    id: /^https:\/\/claude\.ai\/oauth\/mcp-oauth-client-metadata$/,
    // A Anthropic avisa que o retorno pode passar pra claude.com.
    origens: ['https://claude.ai', 'https://claude.com'],
  },
];

/** Qual cliente é este `client_id`? */
const clienteDoId = (clientId) =>
  (typeof clientId === 'string' && CLIENTES.find((c) => c.id.test(clientId))) || null;

/**
 * Documento conhecido, usado só se o dono do documento não responder na hora
 * (o claude.ai fica atrás de um desafio do Cloudflare que pode barrar o Render).
 */
const CLIENTES_CONHECIDOS = {
  'https://chatgpt.com/oauth/client.json': {
    client_name: 'ChatGPT',
    redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  },
  'https://claude.ai/oauth/mcp-oauth-client-metadata': {
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'],
  },
};

// ── Quem pode usar ──────────────────────────────────────────────────────────
// Premium e Platinum (o vitalício da Completa é plano 'premium'). Kit e Básico
// ficam de fora: é diferencial do Premium, como o Oráculo.
const PLANOS = ['premium', 'platinum'];

// ⚠️ TESTE FECHADO. Enquanto o app não estiver publicado no ChatGPT, só estas
// contas entram (mesmo modelo do Open Finance no começo). `IA_CONECTADA_ABERTA=1`
// no Render abre pra todo Premium/Platinum.
const EMAILS_TESTE = [
  'schneider.lenon.s@gmail.com',
  'schineiderlenon@gmail.com',
  'comercialsora@gmail.com',
];

const aberta = () => process.env.IA_CONECTADA_ABERTA === '1';
/** Interruptor geral: `IA_CONECTADA_ATIVA=0` desliga tudo na hora (sem deploy). */
const ativa = () => process.env.IA_CONECTADA_ATIVA !== '0';

/**
 * Esta conta pode usar a Sora no ChatGPT / Claude?
 * @param {{ email?: string|null, plano?: string|null, plano_valido_ate?: string|null }} u
 * @returns {{ ok: boolean, motivo?: 'desligada'|'teste'|'plano' }}
 */
function acessoIa(u, agora = new Date()) {
  if (!ativa()) return { ok: false, motivo: 'desligada' };
  if (!u) return { ok: false, motivo: 'plano' };
  const email = String(u.email || '').trim().toLowerCase();
  if (!aberta() && !EMAILS_TESTE.includes(email)) return { ok: false, motivo: 'teste' };
  let plano = normalizarPlano(u.plano);
  // Mesma regra de vencimento do `exigirPlano`: plano vencido não entra (lá
  // ele também vira 'inativo' no banco; aqui só lemos).
  if (plano !== 'inativo' && plano !== 'gratis' && u.plano_valido_ate
      && new Date(u.plano_valido_ate) < agora) plano = 'inativo';
  if (!PLANOS.includes(plano)) return { ok: false, motivo: 'plano' };
  return { ok: true };
}

module.exports = {
  ...config,
  config,
  CLIENTES,
  clienteDoId,
  CLIENTES_CONHECIDOS,
  PLANOS,
  EMAILS_TESTE,
  acessoIa,
  ativa,
  aberta,
};
