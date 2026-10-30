// =============================================================================
// EVAL DE ROTA — chamado do tipo "dúvida" (POST /api/bug, migration 191).
//
// O suporte foi pra aba Ajuda (out/2026) e ganhou "Tirar uma dúvida". O que
// não pode acontecer:
//   · tipo desconhecido virar coisa nova no banco (só os três valem);
//   · a dúvida SUMIR quando a migration 191 ainda não rodou (o CHECK antigo
//     recusa 'duvida') — ela tem de entrar como 'problema', marcada no texto.
//
// Rodar: npm run eval:chamado-duvida
// =============================================================================
const Module = require('module');
const path = require('path');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.WHATSAPP_PROVIDER = 'meta';

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

async function postar(body, { checkAntigo = false } = {}) {
  const inserts = [];
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) {
      return {
        from: (tabela) => {
          let linha = null;
          const q = {
            insert(obj) { linha = obj; return q; },
            select() { return q; }, eq() { return q; }, update() { return q; },
            single: () => {
              if (tabela === 'bug_reports' && linha) {
                // O CHECK da 053 só conhece 'problema' e 'melhoria'.
                if (checkAntigo && linha.tipo === 'duvida') {
                  return Promise.resolve({ data: null, error: { message: 'violates check constraint "bug_reports_tipo_check"' } });
                }
                inserts.push(linha);
              }
              return Promise.resolve({ data: { id: 'bug-1' }, error: null });
            },
            maybeSingle: () => Promise.resolve({ data: { name: 'Fulano', email: 'f@x.com', plano: 'premium', phone: '5511999999999' }, error: null }),
            then: (res) => res({ data: [], error: null }),
          };
          return q;
        },
      };
    }
    if (req.endsWith('services/proativo')) {
      return { provedor: () => 'meta', enviarProativoDetalhado: async () => ({ ok: true }) };
    }
    if (req.endsWith('services/mensageiro')) return new Proxy({}, { get: () => async () => true });
    if (req.endsWith('services/whatsapp')) return { uploadImagemDataUri: async () => null, enviarTemplate: async () => true };
    if (req.endsWith('services/bugAnexo')) return { salvarAnexo: async () => null, assinarLista: async () => [] };
    if (req.endsWith('middlewares/auth')) return (rq, rs, nx) => nx();
    return origLoad.call(this, req, parent, isMain);
  };
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  }
  const router = require(path.resolve(__dirname, '../src/routes/bug.js'));
  Module._load = origLoad;
  const camada = router.stack.find((c) => c.route?.path === '/' && c.route?.methods?.post);
  const h = camada.route.stack[camada.route.stack.length - 1].handle;
  let status = 200, json = null;
  const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; } };
  await h({ authUser: { id: 'u1' }, body }, res);
  return { status, json, inserts };
}

(async () => {
  let r = await postar({ mensagem: 'Como divido uma conta?', tipo: 'duvida' });
  eq(r.inserts.length, 1, '1. dúvida grava uma linha');
  eq(r.inserts[0]?.tipo, 'duvida', '1. com o tipo dúvida');
  eq(r.inserts[0]?.mensagem, 'Como divido uma conta?', '1. texto intacto');

  r = await postar({ mensagem: 'x', tipo: 'qualquer' });
  eq(r.inserts[0]?.tipo, 'problema', '2. tipo desconhecido vira problema');

  r = await postar({ mensagem: 'ideia', tipo: 'melhoria' });
  eq(r.inserts[0]?.tipo, 'melhoria', '3. melhoria segue melhoria');

  r = await postar({ mensagem: 'Como divido uma conta?', tipo: 'duvida' }, { checkAntigo: true });
  eq(r.inserts.length, 1, '4. sem a 191 a dúvida NÃO some');
  eq(r.inserts[0]?.tipo, 'problema', '4. entra como problema');
  eq(r.inserts[0]?.mensagem, '❓ Dúvida: Como divido uma conta?', '4. marcada no texto');

  r = await postar({ mensagem: 'ideia', tipo: 'melhoria' }, { checkAntigo: true });
  eq(r.inserts[0]?.mensagem, 'ideia', '5. o caminho da 191 não mexe na melhoria');

  r = await postar({ mensagem: '   ', tipo: 'duvida' });
  eq(r.status, 400, '6. dúvida vazia: 400');
  eq(r.json?.erro, 'Escreva sua dúvida antes de enviar.', '6. com a frase da dúvida');

  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ chamado do tipo dúvida: todos os casos passaram');
})().catch((e) => { console.error('✗ eval quebrou:', e); process.exit(1); });
