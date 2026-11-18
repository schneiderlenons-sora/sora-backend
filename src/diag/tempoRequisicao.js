// =============================================================================
// ONDE A REQUISIÇÃO GASTA O TEMPO — medição de produção, sob demanda.
//
// Só liga numa requisição que traga `x-sora-diag: <API_SECRET_TOKEN>`. Aí o
// servidor devolve o cabeçalho `Server-Timing` com:
//   total  — o handler inteiro;
//   banco  — tempo ESPERANDO o Supabase (união dos intervalos: duas idas em
//            paralelo contam uma vez só), com quantas idas e quantas EM SÉRIE;
//   cpu    — CPU do processo no período (aproximado: crons rodando ao mesmo
//            tempo entram junto — medir repetindo e olhar a mediana).
//
// Existe porque "a rota é lenta" tem duas causas com remédios opostos: idas em
// série (paralelizar ajuda) ou CÁLCULO (no plano grátis do Render há 0,1 de
// CPU, e paralelizar não ajuda nada). Medir antes de mexer.
//
// ⚠️ SEM A CHAVE NÃO MUDA NADA: o `fetch` embrulhado só olha o contexto, e sem
// contexto chama o original direto. Crons nunca têm contexto.
// ⚠️ Instalado ANTES de qualquer require que crie o cliente do Supabase.
// =============================================================================
const { AsyncLocalStorage } = require('async_hooks');

const contexto = new AsyncLocalStorage();
let instalado = false;

function instalar() {
  if (instalado || typeof globalThis.fetch !== 'function') return;
  instalado = true;
  const original = globalThis.fetch;
  globalThis.fetch = function fetchMedido(input, init) {
    const st = contexto.getStore();
    if (!st) return original(input, init);
    const url = String((input && input.url) || input || '');
    if (!/supabase\.co/.test(url)) return original(input, init);
    const t0 = performance.now();
    // Só o NOME da tabela/rota (nunca filtro nem valor) — pra achar a ida lenta.
    const alvo = (url.match(/\/rest\/v1\/([^?]+)/) || url.match(/\/(auth\/v1\/[^?]+)/) || [])[1] || '?';
    const p = original(input, init);
    p.then(() => st.idas.push([t0, performance.now(), alvo]), () => st.idas.push([t0, performance.now(), alvo]));
    return p;
  };
}

/** Idas → tempo esperando (união dos intervalos) e quantas foram em série. */
function resumir(idas) {
  const ord = [...idas].sort((a, b) => a[0] - b[0]);
  let ondas = 0; let fimAte = -Infinity; let espera = 0;
  for (const [t0, t1] of ord) {
    if (t0 >= fimAte) { ondas++; espera += t1 - t0; fimAte = t1; }
    else if (t1 > fimAte) { espera += t1 - fimAte; fimAte = t1; }
  }
  return { ondas, espera };
}

function middleware(req, res, next) {
  const chave = process.env.API_SECRET_TOKEN;
  if (!chave || req.get('x-sora-diag') !== chave) return next();
  const st = { idas: [], t0: performance.now(), cpu0: process.cpuUsage() };
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    try {
      const total = performance.now() - st.t0;
      const { ondas, espera } = resumir(st.idas);
      const c = process.cpuUsage(st.cpu0);
      res.setHeader('Server-Timing', [
        `total;dur=${total.toFixed(1)}`,
        `banco;dur=${espera.toFixed(1)};desc="${st.idas.length} idas, ${ondas} em serie"`,
        `cpu;dur=${((c.user + c.system) / 1000).toFixed(1)}`,
      ].join(', '));
      // Cada ida: início (relativo ao começo da requisição), duração e tabela.
      // É o que mostra QUAL consulta está no caminho crítico.
      res.setHeader('X-Sora-Idas', [...st.idas].sort((a, b) => a[0] - b[0])
        .map(([a, b, alvo]) => `${Math.round(a - st.t0)}+${Math.round(b - a)}:${alvo}`).join(' ').slice(0, 4000));
    } catch { /* medição nunca derruba a resposta */ }
    return writeHead.apply(this, args);
  };
  contexto.run(st, next);
}

module.exports = { instalar, middleware, resumir };
