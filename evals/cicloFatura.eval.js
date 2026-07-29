// =============================================================================
// EVAL do ciclo da fatura (services/cicloFatura) — aritmética pura, sem banco.
//
// A fatura vai do dia seguinte ao fechamento anterior até o fechamento (não é o
// mês-calendário). Este eval trava as INVARIANTES que, se quebrarem, corrompem
// dinheiro: ciclos contíguos (sem gap/overlap) e competência ÚNICA por ciclo
// (a `unique(cartao_id, competencia)` da migration 096 depende disso).
//
// Rodar:   node evals/cicloFatura.eval.js
// Sai com código != 0 se algo falhar.
//
// ⚠️ O MESMO conjunto de casos existe em sora-frontend/lib/ciclo-fatura.eval.mjs
//    — as duas saídas têm que ser idênticas, senão painel e WhatsApp divergem
//    (foi o bug real "fatura zerada no zap × R$ 146,89 no painel").
// =============================================================================

const C = require('../src/services/cicloFatura');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };

// ── 1. Casos reais da base (fechamento/vencimento vistos em produção) ────────
// Ciclo que FECHA em julho/2026 (M0 = 6).
const REAIS = [
  { fech: 3,  venc: 10, ini: '2026-06-04', fim: '2026-07-03', comp: '2026-07' },
  { fech: 24, venc: 5,  ini: '2026-06-25', fim: '2026-07-24', comp: '2026-08' }, // vence no mês seguinte
  { fech: 28, venc: 5,  ini: '2026-06-29', fim: '2026-07-28', comp: '2026-08' },
  { fech: 17, venc: 20, ini: '2026-06-18', fim: '2026-07-17', comp: '2026-07' },
  { fech: 5,  venc: 15, ini: '2026-06-06', fim: '2026-07-05', comp: '2026-07' },
];
console.log('── 1. Casos reais da base (fecha em julho/2026) ──');
for (const c of REAIS) {
  const g = C.cicloPorFechamento(2026, 6, c.fech, c.venc);
  const passou = g.ini === c.ini && g.fim === c.fim && g.competencia === c.comp;
  ok(passou, `fech${c.fech}/venc${c.venc}: ${g.ini}→${g.fim} comp ${g.competencia} ≠ ${c.ini}→${c.fim} comp ${c.comp}`);
  console.log(`${passou ? '  ok ' : 'FALHA'}  fech${String(c.fech).padStart(2)}/venc${String(c.venc).padStart(2)}  ${g.label}  vence ${g.venc}  comp ${g.competencia}`);
}

// ── 2. Fechamento > 28 em mês curto (clamp ao ÚLTIMO DIA, nunca a 28) ───────
// 10 cartões da base têm fechamento 29/30/31. O helper antigo clampava em 28.
const CURTOS = [
  { fech: 31, Y: 2026, M0: 1, ini: '2026-02-01', fim: '2026-02-28' }, // fev comum
  { fech: 31, Y: 2026, M0: 2, ini: '2026-03-01', fim: '2026-03-31' },
  { fech: 30, Y: 2026, M0: 1, ini: '2026-01-31', fim: '2026-02-28' },
  { fech: 29, Y: 2028, M0: 1, ini: '2028-01-30', fim: '2028-02-29' }, // bissexto
];
console.log('── 2. Fechamento > 28 em mês curto ──');
for (const c of CURTOS) {
  const g = C.cicloPorFechamento(c.Y, c.M0, c.fech, 10);
  const passou = g.ini === c.ini && g.fim === c.fim;
  ok(passou, `fech${c.fech} ${c.Y}-${c.M0 + 1}: ${g.ini}→${g.fim} ≠ ${c.ini}→${c.fim}`);
  console.log(`${passou ? '  ok ' : 'FALHA'}  fech${c.fech} em ${c.Y}-${String(c.M0 + 1).padStart(2, '0')}  ${g.ini} → ${g.fim}`);
}

// ── 3. INVARIANTES em 24 ciclos seguidos, pra toda combinação fech × venc ───
console.log('── 3. Invariantes (contíguo · competência única · ordem) ──');
let combos = 0;
for (const fech of [1, 3, 5, 17, 24, 28, 29, 30, 31]) {
  for (const venc of [5, 10, 15, 20, 28]) {
    combos++;
    let prevExcl = null;
    const comps = new Set();
    for (let m = 0; m < 24; m++) {
      const c = C.cicloPorFechamento(2026, m, fech, venc);
      if (prevExcl !== null) ok(c.ini === prevExcl, `fech${fech}/venc${venc} m${m}: gap/overlap (${prevExcl} → ${c.ini})`);
      ok(!comps.has(c.competencia), `fech${fech}/venc${venc} m${m}: competência DUPLICADA ${c.competencia}`);
      ok(c.ini <= c.fim && c.venc > c.fim, `fech${fech}/venc${venc} m${m}: ordem inválida`);
      comps.add(c.competencia);
      prevExcl = c.fimExcl;
    }
  }
}
console.log(`  ok    ${combos} combinações × 24 ciclos`);

// ── 4. Round-trip: cicloPorCompetencia(comp do ciclo) devolve o MESMO ciclo ──
console.log('── 4. Round-trip competência → ciclo ──');
for (const fech of [1, 5, 24, 28, 31]) {
  for (const venc of [5, 28]) {
    for (let m = 0; m < 14; m++) {
      const c = C.cicloPorFechamento(2026, m, fech, venc);
      const r = C.cicloPorCompetencia({ dia_fechamento: fech, dia_vencimento: venc }, c.competencia);
      ok(r.ini === c.ini && r.fim === c.fim && r.venc === c.venc,
        `round-trip fech${fech}/venc${venc} comp ${c.competencia}: ${r.ini}→${r.fim} ≠ ${c.ini}→${c.fim}`);
    }
  }
}
console.log('  ok    50 competências reconstruídas');

// ── 5. Fatura "atual" = a do PRÓXIMO vencimento a partir de hoje ─────────────
const ATUAL = [
  { hoje: '2026-07-26', fech: 21, venc: 28, comp: '2026-07' }, // ainda vai vencer 28/07
  { hoje: '2026-07-28', fech: 21, venc: 28, comp: '2026-07' }, // vence HOJE → ainda é a atual
  { hoje: '2026-07-29', fech: 21, venc: 28, comp: '2026-08' }, // venceu → passa pra próxima
  { hoje: '2026-07-26', fech: 24, venc: 5,  comp: '2026-08' }, // vence no mês seguinte
  { hoje: '2026-12-31', fech: 28, venc: 5,  comp: '2027-01' }, // virada de ano
  // venc <= fech E hoje É o dia do vencimento: a fatura que vence HOJE fechou
  // no mês ANTERIOR (fechou 24/07, vence 05/08). Sem olhar 1 mês pra trás, isto
  // devolvia 2026-09 — a fatura errada. 28 cartões da base têm venc <= fech.
  { hoje: '2026-08-05', fech: 24, venc: 5,  comp: '2026-08' },
  { hoje: '2026-08-06', fech: 24, venc: 5,  comp: '2026-09' }, // 1 dia depois → próxima
  { hoje: '2026-01-05', fech: 24, venc: 5,  comp: '2026-01' }, // idem na virada de ano
];
console.log('── 5. competenciaAtual (próximo vencimento ≥ hoje) ──');
for (const c of ATUAL) {
  const g = C.competenciaAtual({ dia_fechamento: c.fech, dia_vencimento: c.venc }, c.hoje);
  const passou = g === c.comp;
  ok(passou, `competenciaAtual(${c.hoje}, fech${c.fech}/venc${c.venc}) = ${g} ≠ ${c.comp}`);
  console.log(`${passou ? '  ok ' : 'FALHA'}  hoje ${c.hoje}  fech${c.fech}/venc${c.venc} → ${g}`);
}

// ── 6. Cartão SEM dia_fechamento → mês-calendário (comportamento legado) ────
console.log('── 6. Fallback sem fechamento = mês-calendário ──');
const semF = C.cicloPorCompetencia({ dia_vencimento: 10 }, '2026-07');
ok(semF.ini === '2026-07-01' && semF.fim === '2026-07-31' && semF.fimExcl === '2026-08-01'
   && semF.competencia === '2026-07' && semF.porCiclo === false, `fallback errado: ${JSON.stringify(semF)}`);
ok(C.competenciaAtual({}, '2026-07-26') === '2026-07', 'competenciaAtual sem fechamento deveria ser o mês');
console.log(`  ok    ${semF.ini} → ${semF.fim} (porCiclo=${semF.porCiclo})`);

// ── 7. O CASO DO CLIENTE: compra dia 30 e dia 01 na MESMA fatura ────────────
console.log('── 7. Caso do cliente (30/07 + 01/08 na mesma fatura, fech 5) ──');
const cc = C.cicloPorCompetencia({ dia_fechamento: 5, dia_vencimento: 15 }, '2026-08');
const dentro = (d) => d >= cc.ini && d < cc.fimExcl;
ok(dentro('2026-07-30') && dentro('2026-08-01'), `caso do cliente falhou: ciclo ${cc.label}`);
console.log(`  ok    fatura ${cc.competencia} (${cc.label}): 30/07 ✓ · 01/08 ✓`);

// ── 8. Navegação entre faturas ──────────────────────────────────────────────
console.log('── 8. Navegação (competenciaVizinha) ──');
const car = { dia_fechamento: 24, dia_vencimento: 5 };
const atual = C.competenciaAtual(car, '2026-07-26');
ok(C.competenciaVizinha(car, atual, -1) === '2026-07', 'vizinha -1 errada');
ok(C.competenciaVizinha(car, atual, +1) === '2026-09', 'vizinha +1 errada');
ok(C.competenciaVizinha({}, '2026-01', -1) === '2025-12', 'vizinha sem fechamento (virada de ano) errada');
console.log(`  ok    ${C.competenciaVizinha(car, atual, -1)} ← ${atual} → ${C.competenciaVizinha(car, atual, 1)}`);

console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) {
  console.log('\n── Falhas ──');
  falhas.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}
