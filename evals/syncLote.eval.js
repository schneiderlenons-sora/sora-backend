// =============================================================================
// EVAL — sync do Open Finance: leitura EM LOTE × uma consulta por transação.
//
// ⚠️ EGRESS. Os quatro passos que tocam linha já importada (reconciliar
// parcela, backfill do lançamento, backfill do mês de faturamento e melhora da
// descrição) faziam UMA consulta por transação a cada sync. Medido em
// 14/09/2026: ~18.400 consultas por rodada, ~1,1 KB cada no fio, com a Celcoin
// sincronizando cada conexão de hora em hora — a ordem do egress diário.
//
// O que este eval trava:
//   1. O ESTADO FINAL DA TABELA é idêntico ao da versão antiga (copiada abaixo,
//      linha por linha), no mesmo cenário — inclusive lote maior que 300,
//      transação repetida no payload e o mesmo of_tx_id em OUTRO grupo.
//   2. O número de consultas cai de N (uma por transação) para ~N/300.
//   3. `of_tx_id` duplicado no grupo segue sendo PULADO (o maybeSingle antigo
//      devolvia erro nessa linha).
//
// Roda sem banco: um Supabase falso em memória, que conta cada ida.
// Rodar:  npm run eval:sync-lote
// =============================================================================
const path = require('path');

// ── Supabase falso ───────────────────────────────────────────────────────────
function criarBanco(linhas) {
  const tabelas = { transacoes: linhas.map((r) => ({ ...r })), of_tx_ignoradas: [] };
  const stats = { selects: 0, updates: 0 };
  const pgParaJs = (p) => new RegExp(p.split('[[:space:]]').join('\\s'), 'i');

  function from(nome) {
    const filtros = [];
    let modo = 'select', patch = null, colunas = '*', unica = false;
    const api = {
      select(c) { colunas = c; return api; },
      update(p) { modo = 'update'; patch = p; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      in(c, arr) { const s = new Set(arr); filtros.push((r) => s.has(r[c])); return api; },
      is(c, v) { filtros.push((r) => (r[c] ?? null) === v); return api; },
      filter(c, op, v) {
        if (op !== 'imatch') throw new Error('op não emulado: ' + op);
        const re = pgParaJs(v);
        filtros.push((r) => re.test(String(r[c] ?? '')));
        return api;
      },
      maybeSingle() { unica = true; return api; },
      then(ok, erro) {
        try {
          const alvo = (tabelas[nome] || []).filter((r) => filtros.every((f) => f(r)));
          if (modo === 'update') {
            stats.updates++;
            alvo.forEach((r) => Object.assign(r, patch));
            return Promise.resolve({ error: null }).then(ok, erro);
          }
          stats.selects++;
          const proj = (r) => {
            if (colunas === '*') return { ...r };
            const o = {};
            colunas.split(',').map((x) => x.trim()).forEach((k) => { o[k] = r[k] ?? null; });
            return o;
          };
          if (unica) {
            if (alvo.length > 1) return Promise.resolve({ data: null, error: { message: 'multiple rows' } }).then(ok, erro);
            return Promise.resolve({ data: alvo[0] ? proj(alvo[0]) : null, error: null }).then(ok, erro);
          }
          // O PostgREST corta em 1000: um lote maior perderia linha em silêncio.
          return Promise.resolve({ data: alvo.slice(0, 1000).map(proj), error: null }).then(ok, erro);
        } catch (e) { return Promise.reject(e).then(ok, erro); }
      },
    };
    return api;
  }
  return { client: { from }, tabelas, stats };
}

// Carrega o sync com o banco falso no lugar do real.
function carregarSync(banco) {
  const alvo = path.resolve(__dirname, '../src/services/polpCelcoinSync.js');
  const db = path.resolve(__dirname, '../src/db/supabase.js');
  delete require.cache[alvo];
  require.cache[db] = { id: db, filename: db, loaded: true, exports: banco.client };
  return require(alvo);
}

// ── A versão ANTIGA, copiada como estava (uma consulta por transação) ────────
function versaoAntiga(supabase, S) {
  const ymd = (d) => (d ? String(d).slice(0, 10) : null);
  return {
    async melhorar(grupoId, txs) {
      const existentes = new Set(supabase === null ? [] : []);
      const ids = txs.map((t) => t.externalId);
      for (let i = 0; i < ids.length; i += 300) {
        const { data } = await supabase.from('transacoes').select('of_tx_id').in('of_tx_id', ids.slice(i, i + 300));
        (data || []).forEach((d) => existentes.add(d.of_tx_id));
      }
      for (let i = 0; i < ids.length; i += 300) {
        const { data } = await supabase.from('of_tx_ignoradas').select('of_tx_id').eq('grupo_id', grupoId).in('of_tx_id', ids.slice(i, i + 300));
        (data || []).forEach((d) => existentes.add(d.of_tx_id));
      }
      const melhoraveis = txs.filter((t) => existentes.has(t.externalId) && t.descricao && !S.RE_DESC_GENERICA.test(t.descricao));
      for (const t of melhoraveis) {
        const { data: atual } = await supabase.from('transacoes')
          .select('id, observacao').eq('of_tx_id', t.externalId).eq('grupo_id', grupoId).maybeSingle();
        if (!atual || !S.RE_DESC_GENERICA.test(String(atual.observacao || ''))) continue;
        await supabase.from('transacoes').update({ observacao: t.descricao.slice(0, 200) }).eq('id', atual.id);
      }
    },
    async reconciliar(grupoId, normalizadas) {
      let n = 0;
      for (const t of normalizadas.filter((x) => x && x.redistribuida)) {
        if (!t.externalId || !t.data) continue;
        const { data: atual } = await supabase.from('transacoes')
          .select('id, data, pago').eq('grupo_id', grupoId).eq('of_tx_id', t.externalId).maybeSingle();
        if (!atual) continue;
        const patch = S.patchReconciliacaoParcela(atual, t);
        if (!patch) continue;
        const { error } = await supabase.from('transacoes').update(patch).eq('id', atual.id);
        if (!error) n++;
      }
      return n;
    },
    async postDate(grupoId, normalizadas) {
      let n = 0;
      for (const t of normalizadas.filter((x) => x && x.externalId && x.billPostDate)) {
        const { data: atual, error } = await supabase.from('transacoes')
          .select('id, of_bill_post_date').eq('grupo_id', grupoId).eq('of_tx_id', t.externalId).maybeSingle();
        if (error) return n;
        if (!atual || atual.of_bill_post_date) continue;
        const { error: e2 } = await supabase.from('transacoes').update({ of_bill_post_date: t.billPostDate }).eq('id', atual.id);
        if (!e2) n++;
      }
      return n;
    },
    async forecast(grupoId, normalizadas) {
      let n = 0;
      for (const t of normalizadas.filter((x) => x && x.externalId && x.billForecast)) {
        const { data: atual, error } = await supabase.from('transacoes')
          .select('id, of_bill_forecast').eq('grupo_id', grupoId).eq('of_tx_id', t.externalId).maybeSingle();
        if (error) return n;
        if (!atual || atual.of_bill_forecast) continue;
        const { error: e2 } = await supabase.from('transacoes').update({ of_bill_forecast: t.billForecast }).eq('id', atual.id);
        if (e2) return n;
        n++;
      }
      return n;
    },
    ymd,
  };
}

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };

// ── Cenário ──────────────────────────────────────────────────────────────────
const G = 'grupo-1', H = 'grupo-2';
function cenario() {
  const linhas = [
    // genérica e sem as colunas de fatura
    { id: 'r1', grupo_id: G, of_tx_id: 'a', observacao: 'Pix', data: '2026-09-01', pago: true, of_bill_forecast: null, of_bill_post_date: null },
    // já preenchida: ninguém toca
    { id: 'r2', grupo_id: G, of_tx_id: 'b', observacao: 'MERCADO X', data: '2026-09-02', pago: true, of_bill_forecast: '2026-09', of_bill_post_date: '2026-09-02' },
    // parcela na data da COMPRA: move
    { id: 'r3', grupo_id: G, of_tx_id: 'c', observacao: 'LOJA 2/3', data: '2026-07-20T18:15:06Z', pago: true, of_bill_forecast: null, of_bill_post_date: null },
    // parcela na data certa, já cobrada, ainda "não paga": vira paga
    { id: 'r4', grupo_id: G, of_tx_id: 'd', observacao: 'JIM.COM PROSED ES', data: '2026-09-03T12:00:00+00:00', pago: false, of_bill_forecast: '2026-09', of_bill_post_date: null },
    // ANTECIPADA: data futura e paga — continua paga
    { id: 'r5', grupo_id: G, of_tx_id: 'e', observacao: 'TV 3/3', data: '2026-11-10', pago: true, of_bill_forecast: null, of_bill_post_date: null },
    // o MESMO of_tx_id em outro grupo: nunca é tocado a partir de G
    { id: 'r6', grupo_id: H, of_tx_id: 'a', observacao: 'Pix', data: '2026-09-01', pago: false, of_bill_forecast: null, of_bill_post_date: null },
    // descrição "Transferência" com acento, genérica
    { id: 'r7', grupo_id: G, of_tx_id: 'g', observacao: '  Transferência ', data: '2026-09-04', pago: true, of_bill_forecast: null, of_bill_post_date: '2026-09-05' },
  ];
  // Lote grande: 700 transações sem os campos de fatura (atravessa 3 lotes de 300).
  for (let i = 0; i < 700; i++) {
    linhas.push({ id: `m${i}`, grupo_id: G, of_tx_id: `m${i}`, observacao: i % 50 === 0 ? 'Pix' : `COMPRA ${i}`,
      data: '2026-08-15', pago: true, of_bill_forecast: i % 3 === 0 ? '2026-08' : null, of_bill_post_date: null });
  }
  const payload = [
    { externalId: 'a', descricao: 'Pix para Maria Silva', billForecast: '2026-09', billPostDate: '2026-09-01', data: '2026-09-01', pago: true },
    { externalId: 'b', descricao: 'MERCADO X LTDA', billForecast: '2026-10', billPostDate: '2026-09-09', data: '2026-09-02', pago: true },
    { externalId: 'c', descricao: 'LOJA', billForecast: '2026-08', billPostDate: '2026-08-20', redistribuida: true, data: '2026-08-20', pago: true, parcelaNum: 2, parcelaTotal: 3, parcelaGrupo: 'P1' },
    { externalId: 'd', descricao: 'JIM.COM PROSED ES', billForecast: '2026-09', billPostDate: '2026-09-03', redistribuida: true, data: '2026-09-03T12:00:00', pago: true, parcelaNum: 2, parcelaTotal: 2, parcelaGrupo: 'P2' },
    { externalId: 'e', descricao: 'TV', billForecast: '2026-11', billPostDate: null, redistribuida: true, data: '2026-11-10', pago: false, parcelaNum: 3, parcelaTotal: 3, parcelaGrupo: 'P3' },
    { externalId: 'g', descricao: 'Transferência para João', billForecast: '2026-09', billPostDate: '2026-09-04', data: '2026-09-04', pago: true },
    // transação REPETIDA no payload: a segunda passada tem de ver o que a primeira gravou
    { externalId: 'a', descricao: 'Pix para Maria Silva', billForecast: '2026-09', billPostDate: '2026-09-01', data: '2026-09-01', pago: true },
    // ainda não importada: nada a fazer em nenhum passo
    { externalId: 'zz', descricao: 'NOVA', billForecast: '2026-09', billPostDate: '2026-09-10', redistribuida: true, data: '2026-09-10', pago: true },
  ];
  for (let i = 0; i < 700; i++) {
    payload.push({ externalId: `m${i}`, descricao: `COMPRA ${i} DETALHADA`, billForecast: '2026-09', billPostDate: '2026-08-16', data: '2026-08-15', pago: true });
  }
  return { linhas, payload };
}

async function rodar(versao, cen) {
  const banco = criarBanco(cen.linhas);
  const S = carregarSync(banco);
  const semNovas = cen.payload.filter((t) => t.externalId !== 'zz');   // inserirTransacoes: só existentes
  if (versao === 'antiga') {
    const v = versaoAntiga(banco.client, S);
    await v.melhorar(G, semNovas);
    const inicio = banco.stats.selects;
    await v.reconciliar(G, cen.payload);
    await v.postDate(G, cen.payload);
    await v.forecast(G, cen.payload);
    return { banco, lendoLinhas: banco.stats.selects - inicio };
  }
  await S.inserirTransacoes(G, 'u1', 'Cartão', semNovas);
  const inicio = banco.stats.selects;
  await S.reconciliarParcelas(G, cen.payload);
  await S.backfillBillPostDate(G, cen.payload);
  await S.backfillBillForecast(G, cen.payload);
  return { banco, lendoLinhas: banco.stats.selects - inicio };
}

(async () => {
  console.log('── 1. o estado final da tabela é o mesmo da versão antiga ──');
  const antiga = await rodar('antiga', cenario());
  const nova = await rodar('nova', cenario());
  const ord = (t) => JSON.stringify(t.slice().sort((a, b) => a.id.localeCompare(b.id)));
  ok(ord(antiga.banco.tabelas.transacoes) === ord(nova.banco.tabelas.transacoes), 'tabela final idêntica');
  if (ord(antiga.banco.tabelas.transacoes) !== ord(nova.banco.tabelas.transacoes)) {
    const A = new Map(antiga.banco.tabelas.transacoes.map((r) => [r.id, r]));
    nova.banco.tabelas.transacoes.filter((r) => JSON.stringify(r) !== JSON.stringify(A.get(r.id))).slice(0, 5)
      .forEach((r) => falhas.push(`  ${r.id}: antiga ${JSON.stringify(A.get(r.id))} × nova ${JSON.stringify(r)}`));
  }
  const T = new Map(nova.banco.tabelas.transacoes.map((r) => [r.id, r]));
  ok(T.get('r1').observacao === 'Pix para Maria Silva', '"Pix" genérico ganhou a descrição do banco');
  ok(T.get('r2').observacao === 'MERCADO X' && T.get('r2').of_bill_forecast === '2026-09', 'linha já preenchida não foi tocada');
  ok(String(T.get('r3').data).startsWith('2026-08-20') && T.get('r3').pago === true, 'parcela na data da compra foi movida');
  ok(T.get('r4').pago === true, 'parcela na data certa virou paga');
  ok(T.get('r5').pago === true, 'antecipada continua paga');
  ok(T.get('r6').observacao === 'Pix' && T.get('r6').of_bill_forecast === null && T.get('r6').pago === false, 'o outro grupo não foi tocado');
  ok(T.get('r7').observacao === 'Transferência para João', 'genérica com acento e espaços também melhora');
  // m298 (1º lote), m301 (2º) e m698 (3º) nascem vazias — múltiplos de 3 já vêm preenchidos.
  ok(T.get('m298').of_bill_forecast === '2026-09' && T.get('m301').of_bill_forecast === '2026-09' && T.get('m698').of_bill_forecast === '2026-09',
    'backfill atravessa as fronteiras dos lotes de 300');
  ok(T.get('m0').of_bill_forecast === '2026-08' && T.get('m300').of_bill_forecast === '2026-08',
    'forecast já preenchido não é sobrescrito');
  ok(T.get('m298').of_bill_post_date === '2026-08-16' && T.get('m698').of_bill_post_date === '2026-08-16',
    'post_date também atravessa os lotes');
  console.log('  ok');

  console.log('── 2. muito menos idas ao banco ──');
  const idasAntigas = antiga.banco.stats.selects, idasNovas = nova.banco.stats.selects;
  console.log(`  consultas de leitura: antiga ${idasAntigas} → nova ${idasNovas}`);
  ok(idasNovas * 20 < idasAntigas, `pelo menos 20× menos leituras (antiga ${idasAntigas}, nova ${idasNovas})`);
  ok(nova.lendoLinhas <= 3 * 3, `reconciliar + 2 backfills: no máximo 3 lotes cada (veio ${nova.lendoLinhas})`);
  ok(antiga.banco.stats.updates === nova.banco.stats.updates, `mesmas gravações (antiga ${antiga.banco.stats.updates}, nova ${nova.banco.stats.updates})`);
  console.log('  ok');

  console.log('── 3. ⚠️ of_tx_id duplicado no grupo segue pulado ──');
  {
    const banco = criarBanco([
      { id: 'x1', grupo_id: G, of_tx_id: 'dup', data: '2026-09-03', pago: false, of_bill_forecast: null, of_bill_post_date: null, observacao: 'Pix' },
      { id: 'x2', grupo_id: G, of_tx_id: 'dup', data: '2026-09-03', pago: false, of_bill_forecast: null, of_bill_post_date: null, observacao: 'Pix' },
      { id: 'x3', grupo_id: G, of_tx_id: 'ok', data: '2026-09-03', pago: false, of_bill_forecast: null, of_bill_post_date: null, observacao: 'x' },
    ]);
    const S = carregarSync(banco);
    const p = [
      { externalId: 'dup', descricao: 'Pix detalhado', billForecast: '2026-09', billPostDate: '2026-09-03', redistribuida: true, data: '2026-09-03', pago: true },
      { externalId: 'ok', descricao: 'x', billForecast: '2026-09', billPostDate: '2026-09-03', redistribuida: true, data: '2026-09-03', pago: true },
    ];
    await S.inserirTransacoes(G, 'u1', 'Cartão', p);
    await S.reconciliarParcelas(G, p);
    await S.backfillBillPostDate(G, p);
    await S.backfillBillForecast(G, p);
    const t = new Map(banco.tabelas.transacoes.map((r) => [r.id, r]));
    ok(['x1', 'x2'].every((k) => t.get(k).pago === false && t.get(k).of_bill_forecast === null && t.get(k).observacao === 'Pix'),
      'as duas linhas duplicadas ficam intactas');
    ok(t.get('x3').pago === true && t.get('x3').of_bill_forecast === '2026-09', 'a linha única segue sendo tratada');
  }
  console.log('  ok');

  console.log('── 4. leitura que falha não grava nada ──');
  {
    const banco = criarBanco([{ id: 'y1', grupo_id: G, of_tx_id: 'y', data: '2026-09-03', pago: false, of_bill_forecast: null, of_bill_post_date: null }]);
    const quebrado = { from: (n) => { const q = banco.client.from(n); const then = q.then; q.then = (ok2, e2) => (q.__update ? then.call(q, ok2, e2) : Promise.resolve({ data: null, error: { message: 'column does not exist' } }).then(ok2, e2)); const up = q.update; q.update = (p) => { q.__update = true; return up.call(q, p); }; return q; } };
    const S = carregarSync({ client: quebrado });
    const p = [{ externalId: 'y', billForecast: '2026-09', billPostDate: '2026-09-03', redistribuida: true, data: '2026-09-03', pago: true }];
    const n1 = await S.backfillBillForecast(G, p), n2 = await S.backfillBillPostDate(G, p), n3 = await S.reconciliarParcelas(G, p);
    ok(n1 === 0 && n2 === 0 && n3 === 0, `migration pendente: nada gravado (veio ${n1}/${n2}/${n3})`);
    ok(banco.tabelas.transacoes[0].pago === false && banco.tabelas.transacoes[0].of_bill_forecast === null, 'linha intacta');
  }
  console.log('  ok');

  console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
  if (falhas.length) { falhas.forEach((f) => console.log(`  · ${f}`)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
