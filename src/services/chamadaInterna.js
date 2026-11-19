// ─────────────────────────────────────────────────────────────────────────────
// Chamada INTERNA a uma rota de leitura do próprio backend, em nome de um
// usuário — usada pelas ferramentas da Sora no ChatGPT (routes/mcp.js).
//
// POR QUE NÃO CHAMAR OS SERVIÇOS DIRETO. A Sora já pagou caro por ter duas
// contas pro mesmo número (5 cópias do vencimento de dívida, 7 do valor da
// fatura, "zap × painel"). Boa parte das regras do que o painel mostra mora
// DENTRO das rotas (fatura atual × próxima, saldo na moeda base, conta da
// empresa, arquivadas, plano exigido). Chamando a rota, o ChatGPT recebe
// exatamente o JSON que o painel recebe — inclusive os 403 de plano — e
// qualquer correção futura numa rota vale pros dois sem ninguém lembrar.
//
// COMO SE PROVA QUEM É. O token do ChatGPT NÃO é um JWT do Supabase (de
// propósito: um JWT daria acesso a TODA rota do backend e ao banco pela API do
// Supabase). Então a rota é chamada por loopback com uma assinatura HMAC:
//   · o segredo é sorteado quando o processo sobe e NUNCA sai da memória;
//   · a assinatura cobre usuário + validade (30 s) + método + caminho exato;
//   · só vale em GET e só vindo de 127.0.0.1.
// Quem está de fora não tem como produzir uma assinatura válida.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const CABECALHO = 'x-sora-interno';
const TTL_MS = 30_000;
const SEGREDO = crypto.randomBytes(32);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mac = (userId, exp, metodo, caminho, segredo = SEGREDO) =>
  crypto.createHmac('sha256', segredo).update(`${userId}.${exp}.${metodo}.${caminho}`).digest();

function assinar({ userId, caminho, agora = Date.now(), segredo }) {
  const exp = agora + TTL_MS;
  return `${userId}.${exp}.${mac(userId, exp, 'GET', caminho, segredo).toString('base64url')}`;
}

const ehLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

/**
 * A requisição é uma chamada interna válida? Devolve `{ userId }` ou `null`.
 * ⚠️ `null` em QUALQUER dúvida — quem chama cai no fluxo normal do JWT.
 */
function verificar(req, { agora = Date.now(), segredo } = {}) {
  const v = req?.headers?.[CABECALHO];
  if (!v || typeof v !== 'string') return null;
  if (req.method !== 'GET') return null;
  if (!ehLoopback(req.socket?.remoteAddress)) return null;
  const partes = v.split('.');
  if (partes.length !== 3) return null;
  const [userId, expStr, assinatura] = partes;
  const exp = Number(expStr);
  if (!UUID.test(userId) || !Number.isFinite(exp) || exp < agora || exp > agora + TTL_MS) return null;
  const esperado = mac(userId, exp, 'GET', req.originalUrl || req.url || '', segredo);
  let recebido;
  try { recebido = Buffer.from(assinatura, 'base64url'); } catch { return null; }
  if (recebido.length !== esperado.length || !crypto.timingSafeEqual(recebido, esperado)) return null;
  return { userId };
}

/**
 * GET numa rota do próprio backend como `userId`.
 * @param {string} caminho  ex.: '/api/dashboard/x?mes=2026-11'
 * @returns {Promise<{ status: number, json: any }>}
 */
async function getInterno(userId, caminho, { timeoutMs = 25_000 } = {}) {
  const porta = process.env.PORT || 3000;
  const url = new URL(caminho, `http://127.0.0.1:${porta}`);
  // Assina o caminho JÁ NORMALIZADO — é exatamente o que o Express vai ver em
  // `req.originalUrl` (acento e espaço chegam codificados).
  const alvo = url.pathname + url.search;
  const r = await fetch(url, {
    headers: { [CABECALHO]: assinar({ userId, caminho: alvo }), accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try { json = await r.json(); } catch { /* corpo vazio ou HTML */ }
  return { status: r.status, json };
}

module.exports = { CABECALHO, assinar, verificar, getInterno };
