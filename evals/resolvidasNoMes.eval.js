// =============================================================================
// EVAL — "esta conta fixa já foi resolvida neste mês?" (services/resolvidasNoMes)
//
// Relato real (set/2026, cliente Fábio): pagou Conta de Luz, Conta de Gás e
// Internet no dia 21 — ANTES do vencimento (28, 26 e 25) — e as três
// continuaram aparecendo como a vencer no card "Ainda vence este mês" do
// painel E no "📌 Ainda neste mês" do resumo do WhatsApp. As transações
// estavam certas no banco (`recorrencia_id` + `competencia`); quem não
// perguntava eram as telas. A regra já existia no CRON e nunca tinha sido
// propagada — era a 3ª cópia divergente.
//
// ⚠️ O QUE ESTE EVAL PROTEGE: os dois lados do erro.
//   · esconder o que JÁ foi resolvido (o bug relatado);
//   · NÃO esconder o que ainda está em aberto — some com a conta fixa da
//     pessoa sem explicação, que é o estrago pior.
//
// Rodar:  npm run eval:resolvidas-no-mes
// =============================================================================
const path = require('path');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

// ── Supabase falso: só o que este service usa (select/in/eq + then) ─────────
function criarBanco({ transacoes = [], previsao_ajustes = [], falhar = null, explodir = false }) {
  const tabelas = { transacoes, previsao_ajustes };
  return {
    from(nome) {
      // ⚠️ Explosão SÍNCRONA: é o que exercita o `catch` do service de verdade.
      // Com um `.then` que só resolve vazio, o catch nunca roda e o eval
      // passava sem testar a degradação (achado pelo teste de mutação).
      if (explodir) throw new Error('banco fora do ar');
      const filtros = [];
      const api = {
        select() { return api; },
        eq(c, v) { filtros.push((r) => r[c] === v); return api; },
        in(c, arr) { const s = new Set(arr); filtros.push((r) => s.has(r[c])); return api; },
        then(ok, err) {
          if (falhar === nome) {
            // Rejeição real da consulta — o service tem de degradar, não quebrar.
            return Promise.resolve(err ? err(new Error('falha de leitura')) : { data: [] }).then(ok ? (v) => v : undefined);
          }
          const data = (tabelas[nome] || []).filter((r) => filtros.every((f) => f(r)));
          return Promise.resolve(ok ? ok({ data }) : { data });
        },
      };
      return api;
    },
  };
}

function carregar(banco) {
  const raiz = path.resolve(__dirname, '../src');
  const f = path.join(raiz, 'db/supabase.js');
  require.cache[f] = { id: f, filename: f, loaded: true, exports: banco };
  const alvo = path.join(raiz, 'services/resolvidasNoMes.js');
  delete require.cache[alvo];
  return require(alvo).resolvidasNoMes;
}

const REC = [
  { id: 'luz',      frequencia: 'mensal' },
  { id: 'gas',      frequencia: 'mensal' },
  { id: 'internet', frequencia: 'mensal' },
  { id: 'agua',     frequencia: 'mensal' },   // esta NÃO foi paga
];

(async () => {
  // ── 1. O CASO DO CLIENTE: pagou adiantado → sai da lista ─────────────────
  console.log('── 1. pagou antes do vencimento ──');
  {
    const resolvidas = await carregar(criarBanco({
      transacoes: [
        { recorrencia_id: 'luz',      competencia: '2026-09' },
        { recorrencia_id: 'gas',      competencia: '2026-09' },
        { recorrencia_id: 'internet', competencia: '2026-09' },
      ],
    }))(REC, '2026-09');
    eq(resolvidas.has('luz'), true, 'luz paga no dia 21 conta como resolvida');
    eq(resolvidas.has('gas'), true, 'gás idem');
    eq(resolvidas.has('internet'), true, 'internet idem');
    eq(resolvidas.has('agua'), false, '⚠️ água NÃO foi paga — continua em aberto');
    eq(resolvidas.size, 3, 'e só essas três');
  }
  console.log('  ok');

  // ── 2. Pulada também é resolvida ─────────────────────────────────────────
  console.log('── 2. conta pulada no mês ──');
  {
    const resolvidas = await carregar(criarBanco({
      previsao_ajustes: [{ recorrencia_id: 'gas', competencia: '2026-09', status: 'pulado' }],
    }))(REC, '2026-09');
    eq(resolvidas.has('gas'), true, 'pulada sai da lista de "ainda vence"');
    eq(resolvidas.size, 1, 'e não arrasta as outras junto');
  }
  console.log('  ok');

  // ── 3. ⚠️ COMPETÊNCIA DE OUTRO MÊS NÃO VALE ──────────────────────────────
  // Sem isso, a luz paga em agosto esconderia a luz de setembro — a pessoa
  // deixaria de ver (e de pagar) a conta do mês.
  console.log('── 3. mês errado não resolve ──');
  {
    const resolvidas = await carregar(criarBanco({
      transacoes: [
        { recorrencia_id: 'luz', competencia: '2026-08' },
        { recorrencia_id: 'gas', competencia: '2026-10' },
      ],
    }))(REC, '2026-09');
    eq(resolvidas.size, 0, 'pagamento de agosto/outubro não resolve setembro');
  }
  console.log('  ok');

  // ── 4. ⚠️ "adiado" NÃO é resolvido ───────────────────────────────────────
  // Só `pulado`. Adiar muda a data; a conta continua a pagar.
  console.log('── 4. adiada continua em aberto ──');
  {
    const resolvidas = await carregar(criarBanco({
      previsao_ajustes: [{ recorrencia_id: 'luz', competencia: '2026-09', status: 'movido' }],
    }))(REC, '2026-09');
    eq(resolvidas.has('luz'), false, 'adiar não é quitar');
  }
  console.log('  ok');

  // ── 5. ⚠️ SEMANAL FICA DE FORA ───────────────────────────────────────────
  // A chave é mensal: a 1ª semana paga bloquearia as outras três do mês.
  console.log('── 5. semanal não entra na chave mensal ──');
  {
    const recs = [{ id: 'feira', frequencia: 'semanal' }];
    const resolvidas = await carregar(criarBanco({
      transacoes: [{ recorrencia_id: 'feira', competencia: '2026-09' }],
    }))(recs, '2026-09');
    eq(resolvidas.has('feira'), false, 'semanal nunca é marcada como resolvida no mês');
  }
  console.log('  ok');

  // ── 6. ⚠️ FALHA DE LEITURA DEGRADA PRO LADO SEGURO ───────────────────────
  // Conjunto vazio = tudo continua aparecendo. O contrário (esconder por
  // engano) sumiria com as contas fixas da base inteira sem aviso.
  console.log('── 6. falha de leitura não esconde nada ──');
  {
    const resolvidas = await carregar(criarBanco({
      transacoes: [{ recorrencia_id: 'luz', competencia: '2026-09' }],
      falhar: 'transacoes',
    }))(REC, '2026-09');
    eq(resolvidas.size, 0, 'leitura quebrada → nada é escondido');

    // E o caso duro: o banco explode SÍNCRONO (fora do ar, não só consulta
    // vazia). Tem de cair no catch e devolver conjunto vazio, não propagar
    // exceção — senão derruba o resumo do WhatsApp e o card inteiro.
    let explodiu = false;
    let vazio = null;
    try { vazio = await carregar(criarBanco({ explodir: true }))(REC, '2026-09'); }
    catch { explodiu = true; }
    eq(explodiu, false, 'banco fora do ar NÃO propaga exceção');
    eq(vazio && vazio.size, 0, 'e devolve conjunto vazio (nada escondido)');

    // ⚠️ NADA DE RESULTADO PARCIAL. A 1ª consulta responde e já marca luz e
    // gás; a 2ª volta malformada (`data` não iterável, como o PostgREST às
    // vezes devolve) e estoura no meio. Sem o `clear()` do catch, sairiam
    // DUAS contas escondidas e as outras não — pior que tudo-ou-nada, porque
    // a pessoa perde justamente as que já tinha visto na tela.
    const parcial = await carregar({
      from(nome) {
        const api = {
          select: () => api, eq: () => api, in: () => api,
          then: (ok) => Promise.resolve(ok({
            data: nome === 'transacoes'
              ? [{ recorrencia_id: 'luz' }, { recorrencia_id: 'gas' }]
              : {},                                   // ← malformado de propósito
          })),
        };
        return api;
      },
    })(REC, '2026-09');
    eq(parcial.size, 0, 'falha no meio descarta o parcial em vez de esconder metade');
  }
  console.log('  ok');

  // ── 7. Bordas ────────────────────────────────────────────────────────────
  console.log('── 7. bordas ──');
  {
    const carregado = carregar(criarBanco({ transacoes: [{ recorrencia_id: 'luz', competencia: '2026-09' }] }));
    eq((await carregado([], '2026-09')).size, 0, 'lista vazia → conjunto vazio');
    eq((await carregado(null, '2026-09')).size, 0, 'lista nula não quebra');

    // ⚠️ SEM COMPETÊNCIA, NÃO AFIRMA NADA. O caso que dá dente: linha com
    // `competencia` vazia no banco (importação antiga, migration não rodada).
    // Sem a guarda `!ym`, a consulta casaria '' com '' e a conta seria dada
    // como paga — some do card sem nunca ter sido paga.
    const comLixo = carregar(criarBanco({
      transacoes: [{ recorrencia_id: 'luz', competencia: '' }],
    }));
    eq((await comLixo(REC, '')).size, 0, 'competência vazia não casa com linha de competência vazia');
  }
  console.log('  ok');

  if (falhas.length) {
    console.error(`\n❌ ${falhas.length} falha(s):`);
    for (const f of falhas) console.error('  - ' + f);
    process.exit(1);
  }
  console.log('\n✅ conta paga/pulada sai de "ainda vence"; o resto continua de pé');
})();
