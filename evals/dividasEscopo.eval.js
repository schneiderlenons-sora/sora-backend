// =============================================================================
// "Minhas dívidas" no WhatsApp: cada um vê SÓ as do próprio grupo.
//
// POR QUE EXISTE. O commit c97c271 (06/09/2026) trocou o `select('*')` da
// listagem por colunas estreitas (economia de egress) e levou o
// `.eq('grupo_id', grupoId)` junto. A consulta passou a devolver as dívidas da
// base INTEIRA: um cliente recebeu "Suas dívidas ativas (140)" com nomes de
// outras famílias. Nada quebrava — a resposta saía bonita e errada.
//
// Passa pelo handler REAL, com um banco falso que aplica os filtros de verdade:
// sem o `.eq('grupo_id')` o outro grupo aparece e este eval reprova.
//
// Rodar: node evals/dividasEscopo.eval.js
// =============================================================================
const path = require('path');

const falhas = [];
const ok = (c, msg) => { if (!c) falhas.push(msg); };

function criarBanco(tabelas) {
  function from(nome) {
    const filtros = [];
    let unica = null;
    const api = {
      select() { return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      in(c, arr) { const s = new Set(arr); filtros.push((r) => s.has(r[c])); return api; },
      or() { return api; }, order() { return api; }, limit() { return api; },
      maybeSingle() { unica = 'maybe'; return api; },
      single() { unica = 'single'; return api; },
      then(res, rej) {
        const linhas = (tabelas[nome] || []).filter((r) => filtros.every((f) => f(r)));
        const data = unica ? (linhas[0] || null) : linhas;
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return api;
  }
  return { from };
}

async function listar(grupoId, tabelas) {
  const raiz = path.resolve(__dirname, '../src');
  for (const k of Object.keys(require.cache)) if (k.startsWith(raiz)) delete require.cache[k];
  const fixar = (rel, exports) => {
    const f = path.join(raiz, rel);
    require.cache[f] = { id: f, filename: f, loaded: true, exports };
  };
  const enviadas = [];
  fixar('db/supabase.js', criarBanco(tabelas));
  fixar('services/mensageiro.js', {
    enviarTexto: async (_p, t) => { enviadas.push(t); },
    enviarMenu: async () => {}, enviarImagem: async () => {}, enviarBotaoLink: async () => {},
  });
  const handle = require(path.join(raiz, 'handlers/dividas.js'));
  await handle({ acao: 'listar_dividas' }, { phone: '5511999990001', grupoId, user: { id: 'u1' } });
  return enviadas.join('\n');
}

(async () => {
  const tabelas = {
    grupos: [{ id: 'gA', moeda_base: 'BRL' }, { id: 'gB', moeda_base: 'BRL' }],
    dividas: [
      { grupo_id: 'gA', titulo: 'Financiamento do carro', status: 'ativa', valor_parcela: 900, parcelas_total: 48, parcelas_pagas: 10, dia_vencimento: 10, lembretes_ativos: true },
      { grupo_id: 'gA', titulo: 'Empréstimo antigo', status: 'quitada', valor_parcela: 100, parcelas_total: 5, parcelas_pagas: 5, dia_vencimento: 5 },
      { grupo_id: 'gB', titulo: 'Guarda-roupa de OUTRA FAMÍLIA', status: 'ativa', valor_parcela: 650, parcelas_total: 7, parcelas_pagas: 2, dia_vencimento: 1 },
      { grupo_id: 'gB', titulo: 'Pensão de OUTRA FAMÍLIA', status: 'em_atraso', valor_parcela: 486, parcelas_total: 12, parcelas_pagas: 0, dia_vencimento: 1 },
    ],
  };

  console.log('── 1. cada grupo vê só as suas ──');
  const a = await listar('gA', tabelas);
  ok(a.includes('Financiamento do carro'), `grupo A vê a própria dívida — veio: ${a}`);
  ok(!/OUTRA FAMÍLIA/.test(a), `⚠️ grupo A NÃO pode ver dívida do grupo B — veio: ${a}`);
  ok(/\(1\)/.test(a), `a contagem é só do grupo A (1) — veio: ${a}`);
  ok(!a.includes('Empréstimo antigo'), 'dívida quitada não entra na lista de ativas');

  const b = await listar('gB', tabelas);
  ok(b.includes('Guarda-roupa de OUTRA FAMÍLIA') && b.includes('Pensão de OUTRA FAMÍLIA') && !b.includes('Financiamento do carro'),
    `grupo B vê só as dele — veio: ${b}`);

  console.log('── 2. sem grupo, nada ──');
  const sem = await listar(null, tabelas);
  ok(!/OUTRA FAMÍLIA|Financiamento/.test(sem), `⚠️ sem grupo ativo não lista NADA da base — veio: ${sem}`);

  console.log('');
  if (falhas.length) {
    console.log(`❌ ${falhas.length} falha(s):`);
    for (const f of falhas) console.log('   · ' + f);
    process.exit(1);
  }
  console.log('✅ dívidas: cada grupo vê só as suas');
})().catch((e) => { console.error(e); process.exit(1); });
