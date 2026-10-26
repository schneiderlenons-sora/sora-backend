// =============================================================================
// Contas fixas num período — a regra ÚNICA da Agenda e do "o que tenho pra pagar".
//
// Trava services/ocorrenciasFixas.js e os dois lugares que a usam:
//   §1 casos à mão: paga antes do vencimento, pulada, adiada (pra dentro, pra
//      fora, adiada E paga), semanal, anual, início/fim, receita, valor ajustado;
//   §2 REGRESSÃO ZERO no WhatsApp: o "a pagar" comparado, em milhares de casos
//      sorteados, com uma CÓPIA CONGELADA do bloco que vivia em aPagarPeriodo.js;
//   §3 a Agenda (agendaFeed.montarFeed) com banco falso: paga vem marcada,
//      pulada some, adiada vai pra data nova, e falha de leitura NÃO esconde
//      nem marca como paga;
//   §4 REGRESSÃO ZERO na Agenda pra conta mensal sem baixa nem ajuste: as
//      mesmas datas da regra antiga (`ocorrenciasMensais`).
//
// Rodar: node evals/ocorrenciasFixas.eval.js
// =============================================================================
const path = require('path');
const { ocorrenciasDeFixas } = require('../src/services/ocorrenciasFixas');
const A = require('../src/services/aPagarPeriodo');
const { venceHoje } = require('../src/services/frequenciaRecorrencia');

const falhas = [];
let total = 0;
const ok = (c, msg) => { total += 1; if (!c) falhas.push(msg); };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}\n     esperado ${JSON.stringify(b)}\n     veio     ${JSON.stringify(a)}`);

const so = (lista, campos) => lista.map((o) => campos.map((c) => o[c]));

// ── §1 CASOS À MÃO ───────────────────────────────────────────────────────────
{
  const out = ['2026-10-01', '2026-10-31'];
  const J = { de: out[0], ate: out[1] };
  const internet = { id: 'r1', tipo: 'Gasto', descricao: 'Internet', valor: 120, dia_vencimento: 25 };

  // O caso do Fábio: pagou no dia 21, vencimento dia 25.
  let r = ocorrenciasDeFixas({ recorrencias: [internet], vinculadas: [{ recorrencia_id: 'r1', competencia: '2026-10' }] }, J);
  eq(so(r, ['data', 'estado', 'adiada']), [['2026-10-25', 'paga', false]],
    '§1 ⚠️ paga ANTES do vencimento: segue no dia 25, mas como PAGA (o relato do Fábio)');

  r = ocorrenciasDeFixas({ recorrencias: [internet] }, J);
  eq(so(r, ['data', 'estado', 'valor']), [['2026-10-25', 'aberta', 120]], '§1 sem baixa: aberta, com o valor da conta');

  // Baixa de OUTRO mês não marca este.
  r = ocorrenciasDeFixas({ recorrencias: [internet], vinculadas: [{ recorrencia_id: 'r1', competencia: '2026-09' }] }, J);
  eq(so(r, ['estado']), [['aberta']], '§1 baixa de setembro não marca outubro como paga');
  // Baixa de OUTRA conta não marca esta.
  r = ocorrenciasDeFixas({ recorrencias: [internet], vinculadas: [{ recorrencia_id: 'r2', competencia: '2026-10' }] }, J);
  eq(so(r, ['estado']), [['aberta']], '§1 baixa de outra conta fixa não marca esta');

  r = ocorrenciasDeFixas({ recorrencias: [internet], ajustes: [{ recorrencia_id: 'r1', competencia: '2026-10', status: 'pulado' }] }, J);
  eq(r, [], '§1 pulada não aparece no mês');
  r = ocorrenciasDeFixas({ recorrencias: [internet], ajustes: [{ recorrencia_id: 'r1', competencia: '2026-09', status: 'pulado' }] }, J);
  eq(so(r, ['data']), [['2026-10-25']], '§1 pular SETEMBRO não esconde outubro');

  // Adiada dentro do mesmo mês.
  r = ocorrenciasDeFixas({ recorrencias: [internet], ajustes: [{ recorrencia_id: 'r1', competencia: '2026-10', status: 'movido', nova_data: '2026-10-29' }] }, J);
  eq(so(r, ['data', 'estado', 'adiada', 'competencia']), [['2026-10-29', 'aberta', true, '2026-10']],
    '§1 adiada: sai do dia 25 e aparece no 29');
  // Adiada pra FORA da janela: some daqui.
  r = ocorrenciasDeFixas({ recorrencias: [internet], ajustes: [{ recorrencia_id: 'r1', competencia: '2026-10', status: 'movido', nova_data: '2026-11-03' }] }, J);
  eq(r, [], '§1 adiada pra novembro: some de outubro');
  // Adiada de setembro PRA DENTRO de outubro (e já paga).
  r = ocorrenciasDeFixas({
    recorrencias: [internet],
    vinculadas: [{ recorrencia_id: 'r1', competencia: '2026-09' }],
    ajustes: [{ recorrencia_id: 'r1', competencia: '2026-09', status: 'movido', nova_data: '2026-10-02', novo_valor: 130 }],
  }, J);
  eq(so(r, ['data', 'competencia', 'estado', 'valor', 'adiada']),
    [['2026-10-25', '2026-10', 'aberta', 120, false], ['2026-10-02', '2026-09', 'paga', 130, true]],
    '§1 ⚠️ adiada de setembro pra 02/10 E paga: aparece em 02/10 como PAGA (baixa de SETEMBRO), e a de outubro segue aberta');

  // Valor ajustado no Extrato só pra esta ocorrência.
  r = ocorrenciasDeFixas({ recorrencias: [internet], ajustes: [{ recorrencia_id: 'r1', competencia: '2026-10', status: 'valor', novo_valor: 99.9 }] }, J);
  eq(so(r, ['valor', 'valorAjustado', 'estado']), [[120, 99.9, 'aberta']], '§1 valor ajustado vem à parte, e a conta segue aberta');

  // Semanal: todas as semanas, e a baixa mensal NÃO marca nenhuma.
  const academia = { id: 'r3', tipo: 'Gasto', descricao: 'Personal', valor: 80, frequencia: 'semanal', dia_semana: 1 }; // segunda
  r = ocorrenciasDeFixas({ recorrencias: [academia], vinculadas: [{ recorrencia_id: 'r3', competencia: '2026-10' }],
    ajustes: [{ recorrencia_id: 'r3', competencia: '2026-10', status: 'pulado' }] }, J);
  eq(so(r, ['data', 'estado']), [['2026-10-05', 'aberta'], ['2026-10-12', 'aberta'], ['2026-10-19', 'aberta'], ['2026-10-26', 'aberta']],
    '§1 ⚠️ semanal: as 4 segundas de outubro, e baixa/pulo mensal não as marca (a chave é mensal)');

  // Anual: só no mês dela.
  const ipva = { id: 'r4', tipo: 'Gasto', descricao: 'IPVA', valor: 900, frequencia: 'anual', mes_vencimento: 1, dia_vencimento: 15 };
  eq(ocorrenciasDeFixas({ recorrencias: [ipva] }, J), [], '§1 anual de janeiro não aparece em outubro');
  eq(so(ocorrenciasDeFixas({ recorrencias: [ipva] }, { de: '2027-01-01', ate: '2027-01-31' }), ['data']), [['2027-01-15']],
    '§1 anual aparece no mês dela');

  // Encerrada e ainda não começada.
  eq(ocorrenciasDeFixas({ recorrencias: [{ ...internet, data_fim: '2026-09-30' }] }, J), [], '§1 ⚠️ conta encerrada em setembro não aparece em outubro');
  eq(ocorrenciasDeFixas({ recorrencias: [{ ...internet, data_inicio: '2026-11-01' }] }, J), [], '§1 conta que começa em novembro não aparece em outubro');

  // Dia 31 em mês curto.
  eq(so(ocorrenciasDeFixas({ recorrencias: [{ ...internet, dia_vencimento: 31 }] }, { de: '2026-11-01', ate: '2026-11-30' }), ['data']),
    [['2026-11-30']], '§1 dia 31 em novembro cai no dia 30');

  // Receita: mesma regra, o estado é o mesmo "paga" (a tela diz "Recebida").
  const salario = { id: 'r5', tipo: 'Recebimento', descricao: 'Salário', valor: 5000, dia_vencimento: 5 };
  r = ocorrenciasDeFixas({ recorrencias: [salario], vinculadas: [{ recorrencia_id: 'r5', competencia: '2026-10' }] }, J);
  eq(so(r, ['data', 'estado']), [['2026-10-05', 'paga']], '§1 receita fixa recebida sai como paga');

  // Janela de dois meses: cada mês com o seu estado.
  r = ocorrenciasDeFixas({ recorrencias: [internet], vinculadas: [{ recorrencia_id: 'r1', competencia: '2026-10' }] }, { de: '2026-10-01', ate: '2026-11-30' });
  eq(so(r, ['data', 'estado']), [['2026-10-25', 'paga'], ['2026-11-25', 'aberta']], '§1 dois meses: outubro paga, novembro aberta');

  // Valor zero/ausente vira null (não "R$ 0,00").
  eq(so(ocorrenciasDeFixas({ recorrencias: [{ ...internet, valor: 0 }] }, J), ['valor']), [[null]], '§1 valor 0 vira null');

  // Ajuste de conta que não existe mais (desativada) é ignorado.
  eq(ocorrenciasDeFixas({ recorrencias: [], ajustes: [{ recorrencia_id: 'rX', competencia: '2026-10', status: 'movido', nova_data: '2026-10-10' }] }, J), [],
    '§1 adiada de conta que não está na lista não aparece');
}

// ── §2 REGRESSÃO ZERO NO "A PAGAR" (cópia congelada) ─────────────────────────
// O bloco de contas fixas de montarItens ANTES de out/2026, copiado sem mudar.
function fixasAntigo(dados, janela) {
  const { de, ate } = janela;
  const itens = [];
  const dentro = (d) => d && d >= de && d <= ate;
  const diasEntre = (a, b) => { const out = []; for (let d = a; d <= b && out.length <= 92 + 31; d = A.somarDias(d, 1)) out.push(d); return out; };
  const vinc = new Set((dados.vinculadas || []).map((v) => `${v.recorrencia_id}|${v.competencia}`));
  const ajuste = new Map((dados.ajustes || []).map((a) => [`${a.recorrencia_id}|${a.competencia}`, a]));
  const dias = diasEntre(de, ate);
  for (const r of dados.recorrencias || []) {
    if (r.tipo && r.tipo !== 'Gasto') continue;
    const semanal = (r.frequencia || 'mensal') === 'semanal';
    for (const d of dias) {
      if (!venceHoje(r, d)) continue;
      const comp = d.slice(0, 7);
      if (!semanal) {
        if (vinc.has(`${r.id}|${comp}`)) continue;
        const aj = ajuste.get(`${r.id}|${comp}`);
        if (aj?.status === 'pulado') continue;
        if (aj?.status === 'movido') continue;
      }
      itens.push({ data: d, descricao: r.descricao || 'Conta fixa', origem: 'fixa',
        valor: Number(r.valor) > 0 ? Number(r.valor) : null, variavel: !!r.valor_variavel });
    }
  }
  const recPorId = new Map((dados.recorrencias || []).map((r) => [r.id, r]));
  for (const a of dados.ajustes || []) {
    if (a.status !== 'movido' || !dentro(String(a.nova_data || '').slice(0, 10))) continue;
    const r = recPorId.get(a.recorrencia_id);
    if (!r || (r.tipo && r.tipo !== 'Gasto')) continue;
    if (vinc.has(`${r.id}|${a.competencia}`)) continue;
    const v = Number(a.novo_valor) > 0 ? Number(a.novo_valor) : Number(r.valor);
    itens.push({ data: String(a.nova_data).slice(0, 10), descricao: r.descricao || 'Conta fixa', origem: 'fixa',
      valor: v > 0 ? v : null, variavel: !!r.valor_variavel, detalhe: 'adiada' });
  }
  return itens;
}

// Sorteio determinístico (mulberry32) — a mesma semente dá a mesma base.
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
{
  const R = rng(20261026);
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const comps = ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01'];
  const datas = ['2026-09-20', '2026-10-01', '2026-10-15', '2026-10-31', '2026-11-02', '2026-11-30', '2026-12-25', '', null];
  const ord = (l) => l.map((i) => JSON.stringify(i)).sort();
  let casos = 0, comItens = 0;
  for (let k = 0; k < 4000; k++) {
    const n = 1 + Math.floor(R() * 4);
    const recorrencias = [];
    for (let i = 0; i < n; i++) {
      const freq = pick(['mensal', 'mensal', 'semanal', 'anual', undefined]);
      recorrencias.push({
        id: `r${i}`, tipo: pick(['Gasto', 'Gasto', 'Recebimento', undefined]),
        descricao: pick(['Luz', 'Internet', '', null]), valor: pick([0, 50, 120.5, null, '89.9']),
        valor_variavel: R() < 0.3, dia_vencimento: pick([1, 5, 15, 25, 28, 30, 31]),
        frequencia: freq, dia_semana: pick([0, 1, 3, 6, null]), mes_vencimento: pick([1, 10, 11, 12]),
        data_inicio: pick([null, null, '2026-10-10', '2026-11-15']), data_fim: pick([null, null, '2026-10-20', '2026-12-31']),
      });
    }
    const vinculadas = [];
    for (let i = 0; i < Math.floor(R() * 5); i++) vinculadas.push({ recorrencia_id: `r${Math.floor(R() * n)}`, competencia: pick(comps) });
    const ajustes = [];
    for (let i = 0; i < Math.floor(R() * 5); i++) {
      ajustes.push({ recorrencia_id: `r${Math.floor(R() * (n + 1))}`, competencia: pick(comps),
        status: pick(['pulado', 'movido', 'movido', 'valor']), nova_data: pick(datas), novo_valor: pick([null, 0, 77, 150]) });
    }
    const de = pick(['2026-10-01', '2026-10-13', '2026-09-28', '2026-11-01']);
    const ate = A.somarDias(de, pick([0, 1, 6, 30, 61, 92]));
    const dados = { recorrencias, vinculadas, ajustes, pendentes: [], dividas: [], faturas: [] };
    const antigo = fixasAntigo(dados, { de, ate });
    const novo = A.montarItens(dados, { de, ate }, de).filter((i) => i.origem === 'fixa');
    casos += 1; if (antigo.length) comItens += 1;
    if (JSON.stringify(ord(antigo)) !== JSON.stringify(ord(novo))) {
      ok(false, `§2 ⚠️ "a pagar" mudou no caso ${k} (${de}..${ate}):\n     antigo ${JSON.stringify(antigo)}\n     novo   ${JSON.stringify(novo)}\n     dados  ${JSON.stringify(dados)}`);
      break;
    }
  }
  ok(casos === 4000, `§2 rodou ${casos} casos`);
  ok(comItens > 1500, `§2 a base sorteada tem de exercitar a regra (só ${comItens} casos com conta a pagar)`);
  total += casos;
}

// ── §3 A AGENDA, COM BANCO FALSO ─────────────────────────────────────────────
function bancoFalso(tabelas, opcoes = {}) {
  return {
    from(nome) {
      const filtros = [];
      let colunas = '*';
      const api = {
        select(c) { colunas = c || '*'; return api; },
        eq(c, v) { filtros.push((r) => r[c] === v); return api; },
        in(c, arr) { const s = new Set(arr); filtros.push((r) => s.has(r[c])); return api; },
        not(c, op, v) { if (op === 'is') filtros.push((r) => (r[c] ?? null) !== v); return api; },
        gte() { return api; }, lte() { return api; }, lt() { return api; }, gt() { return api; },
        order() { return api; }, limit() { return api; }, or() { return api; }, is() { return api; },
        maybeSingle() { return api; }, single() { return api; },
        then(res, rej) {
          return Promise.resolve().then(() => {
            const err = opcoes.erro && opcoes.erro(nome, colunas);
            if (err) return { data: null, error: { message: err } };
            // Projeta as colunas pedidas, como o banco de verdade: devolver a
            // linha inteira esconderia a leitura de coluna que a query não pediu.
            const proj = (r) => {
              if (colunas.includes('*')) return { ...r };
              const o = {};
              for (const c of colunas.split(',').map((x) => x.trim())) o[c] = r[c] === undefined ? null : r[c];
              return o;
            };
            return { data: (tabelas[nome] || []).filter((r) => filtros.every((f) => f(r))).map(proj), error: null };
          }).then(res, rej);
        },
      };
      return api;
    },
  };
}
function carregarFeed(banco) {
  const raiz = path.join(__dirname, '..', 'src');
  const dbPath = require.resolve(path.join(raiz, 'db', 'supabase'));
  for (const k of Object.keys(require.cache)) if (k.startsWith(raiz)) delete require.cache[k];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: banco };
  return require(path.join(raiz, 'services', 'agendaFeed.js'));
}

async function secao3() {
  const G = 'g1';
  const recs = [
    { id: 'net', grupo_id: G, ativa: true, tipo: 'Gasto', descricao: 'Internet', valor: 120, dia_vencimento: 25 },
    { id: 'luz', grupo_id: G, ativa: true, tipo: 'Gasto', descricao: 'Luz', valor: 200, dia_vencimento: 10 },
    { id: 'agua', grupo_id: G, ativa: true, tipo: 'Gasto', descricao: 'Água', valor: 80, dia_vencimento: 12 },
    { id: 'sal', grupo_id: G, ativa: true, tipo: 'Recebimento', descricao: 'Salário', valor: 5000, dia_vencimento: 5 },
    { id: 'pers', grupo_id: G, ativa: true, tipo: 'Gasto', descricao: 'Personal', valor: 80, frequencia: 'semanal', dia_semana: 1 },
    { id: 'gas', grupo_id: G, ativa: true, tipo: 'Gasto', descricao: 'Gás', valor: 60, dia_vencimento: 18 },
    { id: 'fim', grupo_id: G, ativa: true, tipo: 'Gasto', descricao: 'Curso', valor: 300, dia_vencimento: 8, data_fim: '2026-09-30' },
    { id: 'off', grupo_id: G, ativa: false, tipo: 'Gasto', descricao: 'Desativada', valor: 1, dia_vencimento: 3 },
    { id: 'outro', grupo_id: 'g2', ativa: true, tipo: 'Gasto', descricao: 'De outro grupo', valor: 1, dia_vencimento: 3 },
  ];
  const tabelas = {
    recorrencias: recs,
    transacoes: [
      { grupo_id: G, recorrencia_id: 'net', competencia: '2026-10' },   // Internet paga antes do dia 25
      { grupo_id: G, recorrencia_id: 'sal', competencia: '2026-10' },   // salário recebido
      { grupo_id: G, recorrencia_id: 'agua', competencia: '2026-09' },  // água de SETEMBRO paga (adiada pra 02/10)
      { grupo_id: 'g2', recorrencia_id: 'luz', competencia: '2026-10' }, // baixa de OUTRO grupo não vale
      { grupo_id: G, recorrencia_id: null, competencia: null },
    ],
    previsao_ajustes: [
      { grupo_id: G, recorrencia_id: 'luz', competencia: '2026-10', status: 'pulado' },
      { grupo_id: G, recorrencia_id: 'agua', competencia: '2026-09', status: 'movido', nova_data: '2026-10-02' },
      { grupo_id: G, recorrencia_id: 'agua', competencia: '2026-10', status: 'movido', nova_data: '2026-10-25', novo_valor: 95 },
      // ⚠️ Internet de SETEMBRO adiada pro dia 25/10 — o MESMO dia da de outubro.
      { grupo_id: G, recorrencia_id: 'net', competencia: '2026-09', status: 'movido', nova_data: '2026-10-25' },
      // Valor ajustado no Extrato só pra outubro.
      { grupo_id: G, recorrencia_id: 'gas', competencia: '2026-10', status: 'valor', novo_valor: 55 },
    ],
  };
  const fixas = (ev) => ev.filter((e) => e.source === 'recorrencia')
    .map((e) => [e.data, e.titulo, e.pago, e.adiada, e.valor]).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));

  const F = carregarFeed(bancoFalso(tabelas));
  const ev = await F.montarFeed(G, '2026-10-01', '2026-10-31');
  eq(fixas(ev), [
    ['2026-10-02', 'Água', true, true, 80],
    ['2026-10-05', 'Personal', false, false, 80],
    ['2026-10-05', 'Salário', true, false, 5000],
    ['2026-10-12', 'Personal', false, false, 80],
    ['2026-10-18', 'Gás', false, false, 55],
    ['2026-10-19', 'Personal', false, false, 80],
    ['2026-10-25', 'Água', false, true, 95],
    ['2026-10-25', 'Internet', true, false, 120],
    ['2026-10-25', 'Internet', false, true, 120],
    ['2026-10-26', 'Personal', false, false, 80],
  ], '§3 ⚠️ Agenda de outubro: Internet e salário marcados, luz pulada some, água de set. adiada e paga em 02/10, '
    + 'água de out. adiada pro 25 com valor novo, Internet de set. adiada pro mesmo dia da de out., gás com valor ajustado, '
    + 'semanal toda segunda, curso encerrado fora');

  const ids = ev.filter((e) => e.source === 'recorrencia').map((e) => e.id);
  ok(new Set(ids).size === ids.length, `§3 ids sem repetição (a tela usa como chave): ${ids.join(', ')}`);
  ok(ids.includes('rec-net-2026-10-25'), '§3 a ocorrência comum mantém o id de sempre');
  const sal = ev.find((e) => e.titulo === 'Salário');
  ok(sal.receita === true && sal.cor === '#16a34a', '§3 receita marcada como receita, na cor verde de sempre');
  const net = ev.find((e) => e.titulo === 'Internet');
  ok(net.receita === false && net.cor === '#dc2626' && net.deeplink === '/transacoes' && net.editavel === false,
    '§3 conta fixa segue com cor, link e "não editável" de sempre');

  // O briefing continua SEM contas fixas.
  const brief = await F.montarFeed(G, '2026-10-25', '2026-10-25', { paraBriefing: true });
  eq(brief.filter((e) => e.source === 'recorrencia'), [], '§3 o briefing matinal continua sem contas fixas');

  // ⚠️ Falha ao ler as BAIXAS: nada vira "paga" e nada some.
  const F2 = carregarFeed(bancoFalso(tabelas, { erro: (n) => (n === 'transacoes' ? 'boom' : null) }));
  const ev2 = await F2.montarFeed(G, '2026-10-01', '2026-10-31');
  ok(fixas(ev2).every((e) => e[2] === false), '§3 ⚠️ sem conseguir ler as baixas, NADA aparece como paga');
  ok(fixas(ev2).some((e) => e[1] === 'Internet'), '§3 ⚠️ e a conta continua aparecendo');

  // ⚠️ Falha ao ler os AJUSTES: tudo aparece na data de sempre (nada some).
  const F3 = carregarFeed(bancoFalso(tabelas, { erro: (n) => (n === 'previsao_ajustes' ? 'boom' : null) }));
  const ev3 = fixas(await F3.montarFeed(G, '2026-10-01', '2026-10-31'));
  ok(ev3.some((e) => e[1] === 'Luz' && e[0] === '2026-10-10'), '§3 ⚠️ sem conseguir ler os ajustes, a luz pulada APARECE (não some por falta de dado)');
  ok(ev3.some((e) => e[1] === 'Água' && e[0] === '2026-10-12' && e[3] === false), '§3 sem ajustes, a água fica na data original');

  // Coluna de frequência faltando → lê do jeito antigo, tudo mensal.
  const F4 = carregarFeed(bancoFalso(tabelas, { erro: (n, c) => (n === 'recorrencias' && c.includes('frequencia') ? 'column does not exist' : null) }));
  const ev4 = fixas(await F4.montarFeed(G, '2026-10-01', '2026-10-31'));
  ok(ev4.some((e) => e[1] === 'Internet' && e[2] === true), '§3 sem as colunas novas: lê do jeito antigo e ainda marca a paga');
  ok(ev4.filter((e) => e[1] === 'Personal').length <= 1, '§3 sem as colunas novas, a semanal é lida como mensal (como antes)');

  // Sem conta fixa nenhuma: não consulta baixa/ajuste à toa.
  const lidas = [];
  const vazio = bancoFalso({ recorrencias: [] });
  const espiao = { from(n) { lidas.push(n); return vazio.from(n); } };
  await carregarFeed(espiao).montarFeed(G, '2026-10-01', '2026-10-31');
  ok(!lidas.includes('previsao_ajustes'), '§3 sem conta fixa, não lê ajustes (egress: o custo é o NÚMERO de idas)');
}

// ── §4 REGRESSÃO ZERO NA AGENDA (mensal, sem baixa nem ajuste) ───────────────
async function secao4() {
  const G = 'g1';
  const isoLocal = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  function ocorrenciasMensaisAntiga(dia, deStr, ateStr) {
    if (!dia) return [];
    const de = new Date(deStr + 'T12:00:00'), ate = new Date(ateStr + 'T12:00:00');
    const out = [];
    let y = de.getFullYear(), m = de.getMonth();
    while (new Date(y, m, 1) <= ate) {
      const ultimoDia = new Date(y, m + 1, 0).getDate();
      const d = new Date(y, m, Math.min(dia, ultimoDia), 12);
      if (d >= de && d <= ate) out.push(isoLocal(d));
      m++; if (m > 11) { m = 0; y++; }
    }
    return out;
  }
  const R = rng(777);
  let iguais = 0;
  for (let k = 0; k < 300; k++) {
    const recs = [];
    for (let i = 0; i < 3; i++) recs.push({ id: `m${i}`, grupo_id: G, ativa: true, tipo: R() < 0.7 ? 'Gasto' : 'Recebimento',
      descricao: `C${i}`, valor: 10 + i, dia_vencimento: 1 + Math.floor(R() * 31) });
    const de = A.somarDias('2026-01-01', Math.floor(R() * 400));
    const ate = A.somarDias(de, Math.floor(R() * 211));
    const F = carregarFeed(bancoFalso({ recorrencias: recs }));
    const novo = (await F.montarFeed(G, de, ate)).filter((e) => e.source === 'recorrencia').map((e) => e.id).sort();
    const antigo = recs.flatMap((r) => ocorrenciasMensaisAntiga(r.dia_vencimento, de, ate).map((d) => `rec-${r.id}-${d}`)).sort();
    if (JSON.stringify(novo) !== JSON.stringify(antigo)) {
      ok(false, `§4 ⚠️ datas mudaram (${de}..${ate})\n     antigo ${antigo}\n     novo   ${novo}`);
      break;
    }
    iguais += 1;
  }
  ok(iguais === 300, `§4 a Agenda de conta mensal comum dá as MESMAS datas de antes (${iguais}/300)`);
}

(async () => {
  await secao3();
  await secao4();
  if (falhas.length) {
    console.error(`❌ ${falhas.length} falha(s) em ${total} verificações:\n  - ${falhas.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`✅ contas fixas (agenda + a pagar): ${total} verificações`);
})();
