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

// ── 9. ⚠️ Opção "compra no dia do fechamento vai pra PRÓXIMA" (migration 200) ─
// Sugestão do Arisson (nov/2026, Itaú manual). É POR CARTÃO: a medição mostrou
// que trocar pra todos fazia 11 faturas já pagas aparecerem atrasadas.
console.log('── 9. Dia do fechamento na próxima fatura (opção do cartão) ──');
{
  // 9a. REGRESSÃO ZERO sem a opção: cópia congelada da função ANTIGA.
  const iso = (d) => d.toISOString().slice(0, 10);
  const antigo = (Y, M0, fech, venc) => {
    const fim = C.fechamentoDe(Y, M0, fech);
    const antY = M0 === 0 ? Y - 1 : Y, antM = M0 === 0 ? 11 : M0 - 1;
    const ini = new Date(C.fechamentoDe(antY, antM, fech)); ini.setUTCDate(ini.getUTCDate() + 1);
    const fimExcl = new Date(fim); fimExcl.setUTCDate(fimExcl.getUTCDate() + 1);
    const v = C.vencimentoApos(fim, venc);
    return { ini: iso(ini), fim: iso(fim), fimExcl: iso(fimExcl), venc: iso(v) };
  };
  let casos = 0, iguais = 0;
  for (const Y of [2025, 2026, 2027, 2028]) for (let M0 = 0; M0 < 12; M0++) for (let fech = 1; fech <= 31; fech++) for (const venc of [1, 5, 10, 15, 20, 25, 28, 31]) {
    casos++;
    const a = antigo(Y, M0, fech, venc);
    for (const opcoes of [undefined, {}, { diaNaProxima: false }]) {
      const n = C.cicloPorFechamento(Y, M0, fech, venc, opcoes);
      if (n.ini === a.ini && n.fim === a.fim && n.fimExcl === a.fimExcl && n.venc === a.venc && n.ultimo === n.fim) iguais++;
      else falhas.push(`9a: ${Y}-${M0 + 1} fech ${fech} venc ${venc} ${JSON.stringify(opcoes)} divergiu da regra antiga`);
    }
  }
  ok(iguais === casos * 3, `9a: sem a opção, ${iguais}/${casos * 3} iguais à regra antiga`);
  console.log(`  ok    sem a opção: ${casos} combinações × 3 formas de chamar = iguais à regra antiga`);

  // 9b. Com a opção: o dia do fechamento é da PRÓXIMA; contíguo; o fechamento,
  // o vencimento e a competência NÃO mudam (só as bordas andam um dia).
  const NA = { diaNaProxima: true };
  let contiguos = 0, total = 0;
  for (const Y of [2025, 2026, 2027]) for (let M0 = 0; M0 < 12; M0++) for (let fech = 1; fech <= 31; fech++) {
    const c = C.cicloPorFechamento(Y, M0, fech, 10, NA);
    const prox = C.cicloPorFechamento(Y, M0 + 1, fech, 10, NA);
    const padrao = C.cicloPorFechamento(Y, M0, fech, 10);
    total++;
    if (c.fimExcl === prox.ini) contiguos++;
    else falhas.push(`9b: ${Y}-${M0 + 1} fech ${fech}: buraco/sobreposição (${c.fimExcl} × ${prox.ini})`);
    if (c.fimExcl !== c.fim) falhas.push(`9b: fimExcl deveria ser o próprio fechamento (${c.fimExcl} × ${c.fim})`);
    if (!(c.ultimo < c.fim)) falhas.push(`9b: o último dia deveria ser a véspera do fechamento (${c.ultimo} × ${c.fim})`);
    if (c.fim !== padrao.fim || c.venc !== padrao.venc || c.competencia !== padrao.competencia) {
      falhas.push(`9b: fechamento/vencimento/competência NÃO podem mudar com a opção (${Y}-${M0 + 1} fech ${fech})`);
    }
  }
  ok(contiguos === total, `9b: ${contiguos}/${total} ciclos contíguos com a opção`);
  console.log(`  ok    com a opção: ${total} ciclos contíguos, fechamento e vencimento intactos`);

  // 9c. O caso do Arisson: Itaú manual, fecha 24, vence 1. Compra em 24/11.
  const arisson = { dia_fechamento: 24, dia_vencimento: 1, of_conta_id: null };
  const comOp = { ...arisson, fechamento_dia_proxima: true };
  ok(C.cicloPorCompetencia(arisson, '2026-12').fimExcl === '2026-11-25', '9c: padrão — a fatura de dezembro vai até 24/11 inclusive');
  ok(C.cicloPorCompetencia(comOp, '2026-12').fimExcl === '2026-11-24', '9c: com a opção — a fatura de dezembro termina em 23/11');
  ok(C.cicloPorCompetencia(comOp, '2027-01').ini === '2026-11-24', '9c: com a opção — a compra de 24/11 abre a fatura de janeiro');
  ok(C.cicloPorCompetencia(comOp, '2026-12').label === '24/10 a 23/11', '9c: o rótulo mostra o último dia que entra (23/11)');
  ok(C.cicloPorCompetencia(arisson, '2026-12').label === '25/10 a 24/11', '9c: rótulo do padrão intacto');
  console.log(`  ok    Arisson: compra de 24/11 → fatura ${C.cicloPorCompetencia(comOp, '2027-01').competencia} (${C.cicloPorCompetencia(comOp, '2027-01').label})`);

  // 9d. Quem decide: só cartão MANUAL com a opção. Open Finance ignora.
  ok(C.diaNaProximaDe({ fechamento_dia_proxima: true, of_conta_id: null }) === true, '9d: manual com a opção → próxima');
  ok(C.diaNaProximaDe({ fechamento_dia_proxima: true }) === true, '9d: manual (sem of_conta_id) com a opção → próxima');
  ok(C.diaNaProximaDe({ fechamento_dia_proxima: true, of_conta_id: 'acc1' }) === false, '9d: ⚠️ Open Finance IGNORA a opção');
  ok(C.diaNaProximaDe({ fechamento_dia_proxima: false }) === false, '9d: opção desligada');
  ok(C.diaNaProximaDe({ fechamento_dia_proxima: 'true' }) === false, '9d: só o booleano true liga');
  ok(C.diaNaProximaDe(null) === false && C.diaNaProximaDe({}) === false, '9d: sem cartão ou sem a coluna → padrão');
  const of = { dia_fechamento: 24, dia_vencimento: 1, of_conta_id: 'acc1', fechamento_dia_proxima: true };
  ok(JSON.stringify(C.cicloPorCompetencia(of, '2026-12')) === JSON.stringify(C.cicloPorCompetencia({ dia_fechamento: 24, dia_vencimento: 1 }, '2026-12')),
    '9d: cartão do Open Finance com a opção marcada calcula igual ao padrão');

  // 9e. A fatura "atual" (escolhida pelo vencimento) e a navegação não mudam.
  for (const hoje of ['2026-11-23', '2026-11-24', '2026-11-25', '2026-12-01', '2026-12-02']) {
    ok(C.competenciaAtual(comOp, hoje) === C.competenciaAtual(arisson, hoje), `9e: a fatura "atual" não muda com a opção (${hoje})`);
  }
  ok(C.competenciaVizinha(comOp, '2026-12', 1) === '2027-01' && C.competenciaVizinha(comOp, '2026-12', -1) === '2026-11', '9e: vizinhas com a opção');
  console.log('  ok    fatura atual e navegação iguais com e sem a opção');
}

console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) {
  console.log('\n── Falhas ──');
  falhas.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}
