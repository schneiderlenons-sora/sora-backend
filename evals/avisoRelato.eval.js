// =============================================================================
// EVAL DE ROTA — o relato de bug vira aviso no WhatsApp do suporte?
//
// Relato do dono (02/10/2026): "não recebi nenhuma mensagem dos últimos
// relatos de bugs". Os relatos estavam no banco (8 em 48h): o insert
// funcionava, o aviso é que não saía — e a falha morria num `console.warn`.
//
// A rota chamava `enviarTemplate('novo_relato')` DIRETO. Um modelo não
// aprovado na WABA derrubava o canal inteiro, em silêncio.
//
// ⚠️ Aqui a rota REAL roda com a Meta falsa, e o teste só passa se o aviso
// chegar mesmo quando o modelo preferido é recusado.
//
// Rodar:  node evals/avisoRelato.eval.js
// =============================================================================
const Module = require('module');
const path = require('path');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.WHATSAPP_PROVIDER = 'meta';

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

/**
 * Monta a rota com um "WhatsApp" falso.
 * @param recusa nomes de modelo que a Meta vai recusar (falha 132xxx)
 * @param ambiguo nomes que falham de forma AMBÍGUA (timeout/5xx)
 */
function carregar({ recusa = [], ambiguo = [] } = {}) {
  const tentados = [];
  const updates = [];

  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) {
      return {
        from: () => {
          const q = {
            _patch: null,
            insert() { return q; }, select() { return q; }, eq() { return q; },
            update(p) { updates.push(p); return q; },
            single: () => Promise.resolve({ data: { id: 'bug-1' }, error: null }),
            maybeSingle: () => Promise.resolve({ data: { name: 'Fulano', email: 'f@x.com', plano: 'premium', phone: '5511999999999' }, error: null }),
            then: (res) => res({ data: [], error: null }),
          };
          return q;
        },
      };
    }
    if (req.endsWith('services/proativo')) {
      return {
        provedor: () => 'meta',
        enviarProativoDetalhado: async (phone, { template }) => {
          tentados.push(template.name + (template.opts?.headerImage ? '+img' : ''));
          if (recusa.includes(template.name)) return { ok: false, falhaDeModelo: true, code: 132001 };
          if (ambiguo.includes(template.name)) return { ok: false, falhaDeModelo: false, code: 500 };
          return { ok: true, falhaDeModelo: false };
        },
      };
    }
    if (req.endsWith('services/mensageiro')) return new Proxy({}, { get: () => async () => true });
    if (req.endsWith('services/whatsapp')) {
      return { uploadImagemDataUri: async () => null, enviarTemplate: async () => true };
    }
    if (req.endsWith('services/bugAnexo')) {
      return { salvarAnexo: async () => null, assinarLista: async () => [] };
    }
    if (req.endsWith('middlewares/auth')) return (rq, rs, nx) => nx();
    return origLoad.call(this, req, parent, isMain);
  };
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  }
  const router = require(path.resolve(__dirname, '../src/routes/bug.js'));
  Module._load = origLoad;

  const camada = router.stack.find((c) => c.route?.path === '/' && c.route?.methods?.post);
  if (!camada) throw new Error('rota POST /api/bug não encontrada');
  const pilha = camada.route.stack;
  return { handler: pilha[pilha.length - 1].handle, tentados, updates };
}

async function enviarRelato(handler) {
  const req = {
    body: { mensagem: 'A fatura do cartão não bate com a do banco' },
    authUser: { id: 'u1', grupoAtivo: 'g1' },
  };
  let corpo = null;
  const res = { status() { return res; }, json(j) { corpo = j; return res; } };
  await handler(req, res);
  return corpo;
}

(async () => {
  console.log('── 1. caminho feliz: o modelo dedicado entrega ──');
  {
    const { handler, tentados, updates } = carregar();
    const r = await enviarRelato(handler);
    eq(r?.avisado, true, '§1 o aviso saiu');
    eq(tentados.length, 1, '§1 e bastou o primeiro modelo');
    eq(tentados[0].startsWith('novo_relato'), true, '§1 que é o dedicado');
    eq(typeof updates[0]?.avisado_em, 'string', '§1 e a entrega fica registrada na linha');
  }
  console.log('  ok');

  console.log('── 2. ⚠️ O MODELO DEDICADO RECUSADO NÃO PODE DERRUBAR O CANAL ──');
  {
    // Era exatamente isto: `novo_relato` não aprovado na WABA, e NADA chegava.
    const { handler, tentados, updates } = carregar({ recusa: ['novo_relato'] });
    const r = await enviarRelato(handler);
    eq(r?.avisado, true, '⚠️ §2 O AVISO AINDA CHEGA');
    eq(tentados[tentados.length - 1], 'lembretes_gerais', '§2 pelo modelo que sempre entrega');
    eq(tentados.length, 3, '§2 depois de tentar o dedicado com e sem imagem');
    eq(typeof updates[0]?.avisado_em, 'string', '§2 e registra que entregou');
  }
  console.log('  ok');

  console.log('── 3. recusa só por causa da IMAGEM ──');
  {
    // Header de imagem é motivo comum de recusa (URL em cache de 404 na Meta).
    // Só a 1ª tentativa leva imagem, então a 2ª resolve sem perder o modelo bom.
    const { handler, tentados } = carregar({ recusa: ['novo_relato'] });
    await enviarRelato(handler);
    eq(tentados[0], 'novo_relato+img', '§3 a primeira tentativa leva o cabeçalho');
    eq(tentados[1], 'novo_relato', '§3 a segunda tenta o mesmo modelo sem ele');
  }
  console.log('  ok');

  console.log('── 4. ⚠️ FALHA AMBÍGUA NÃO INSISTE (senão duplica o relato) ──');
  {
    // Timeout/5xx: a Meta pode ter aceitado e só a resposta se perdeu. Tentar o
    // próximo modelo mandaria o mesmo relato duas vezes.
    const { handler, tentados } = carregar({ ambiguo: ['novo_relato'] });
    const r = await enviarRelato(handler);
    eq(tentados.length, 1, '⚠️ §4 para na primeira — não arrisca mandar duplicado');
    eq(r?.avisado, false, '§4 e NÃO declara entrega que não pode provar');
  }
  console.log('  ok');

  console.log('── 5. ⚠️ TUDO RECUSADO: o relato é salvo e a falha fica VISÍVEL ──');
  {
    const { handler, updates } = carregar({ recusa: ['novo_relato', 'lembretes_gerais'] });
    const r = await enviarRelato(handler);
    eq(r?.ok, true, '§5 o relato continua sendo salvo (nunca se perde)');
    eq(r?.avisado, false, '§5 mas a resposta diz que não avisou');
    eq(updates[0]?.avisado_em, null, '⚠️ §5 e a linha guarda NULL — deixa de ser invisível');
  }
  console.log('  ok');

  console.log('');
  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ avisoRelato: o relato chega ao suporte, ou a falha fica registrada');
  process.exit(0);
})();
