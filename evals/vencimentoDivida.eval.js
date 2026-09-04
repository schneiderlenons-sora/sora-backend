// =============================================================================
// EVAL do próximo vencimento de dívida.
//
// BUG DE ORIGEM (relatado pelo usuário): "paguei a parcela que vence dia 10 e
// o card continua dizendo 'Próxima parcela em 3 dias'". A regra antiga só
// olhava o calendário, nunca o pagamento.
//
// O que este eval trava:
//  · pagou → o vencimento anda pro mês seguinte (o caso do usuário);
//  · pagou ATRASADO → NÃO anda duas vezes (o pagamento de julho não pode
//    apagar a parcela de agosto) — é o falso positivo mais fácil de cometer;
//  · sem pagamento registrado → resultado IDÊNTICO ao de antes (é o caso das
//    dívidas do Open Finance, onde as pagas vêm do banco). Regressão zero.
//  · mês curto: dia 31 vence em 28/02, não "03/03" (rollover do Date).
//
// Rodar:  npm run eval:vencimento-divida
// =============================================================================
const {
  proximoVencimento, vencimentoCoberto, ocorrencia, diffDias, emAtraso,
} = require('../src/services/vencimentoDivida');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// ── 1. Aritmética base ───────────────────────────────────────────────────
console.log('── 1. ocorrência e diff ──');
{
  eq(ocorrencia(2026, 7, 10), '2026-08-10', 'agosto/10');
  eq(ocorrencia(2026, 1, 31), '2026-02-28', 'dia 31 em fevereiro → clampa no ÚLTIMO dia (não rola pra março)');
  eq(ocorrencia(2024, 1, 31), '2024-02-29', 'fevereiro bissexto → 29');
  eq(ocorrencia(2026, 12, 5), '2027-01-05', 'mês 12 vira janeiro do ano seguinte');
  eq(ocorrencia(2026, -1, 5), '2025-12-05', 'mês -1 vira dezembro do ano anterior');
  eq(ocorrencia(2026, 3, 31), '2026-04-30', 'abril tem 30');
  eq(diffDias('2026-08-07', '2026-08-10'), 3, '7→10 = 3 dias');
  eq(diffDias('2026-08-10', '2026-08-07'), -3, 'passado dá negativo');
  eq(diffDias('2026-08-07', '2026-08-07'), 0, 'mesmo dia = 0');
  eq(diffDias('2026-02-27', '2026-03-01'), 2, 'atravessa fevereiro certo');
}
console.log('  ok');

// ── 2. vencimentoCoberto: qual parcela aquele pagamento quitou ───────────
console.log('── 2. qual vencimento o pagamento cobriu ──');
{
  eq(vencimentoCoberto('2026-08-07', 10), '2026-08-10', 'pagou 3 dias ANTES → quitou a do dia 10 de agosto');
  eq(vencimentoCoberto('2026-07-12', 10), '2026-07-10', 'pagou 2 dias DEPOIS → quitou a de julho (atrasado), não a de agosto');
  eq(vencimentoCoberto('2026-08-10', 10), '2026-08-10', 'pagou no próprio dia');
  eq(vencimentoCoberto('2026-08-01', 10), '2026-08-10', 'início do mês → a de agosto (9d) e não a de julho (22d)');
  eq(vencimentoCoberto('2026-08-25', 10), '2026-08-10', 'empate-ish no meio: fica com a ANTERIOR (15d × 16d)');
  eq(vencimentoCoberto('2026-01-05', 31), '2025-12-31', 'vira o ano pra trás quando é a mais próxima');
}
console.log('  ok');

// ── 3. O CASO DO USUÁRIO ─────────────────────────────────────────────────
console.log('── 3. caso relatado: paguei a do dia 10 e continua "em 3 dias" ──');
{
  // Dívida real da base: Prosed, 5x R$ 328,95, vence dia 10, paga a 2ª em 07/08.
  const prosed = {
    dia_vencimento: 10, data_inicio: '2026-07-07', status: 'ativa',
    ultimo_pagamento: '2026-08-07',
  };
  const r = proximoVencimento(prosed, '2026-08-07');
  eq(r.data, '2026-09-10', 'DEPOIS de pagar, a próxima é só em setembro');
  eq(r.dias, 34, 'e a contagem de dias acompanha');
  ok(r.quitadaNoCiclo, 'marca que a parcela do ciclo já foi paga');

  // O comportamento ANTIGO (sem pagamento) é o que estava errado na tela.
  const antes = proximoVencimento({ ...prosed, ultimo_pagamento: null }, '2026-08-07');
  eq(antes.dias, 3, 'sem pagamento registrado, seguia sendo "em 3 dias" — o bug');
}
console.log('  ok');

// ── 4. Pagou ATRASADO não pode pular a parcela seguinte ──────────────────
// O erro fácil aqui é "houve pagamento no ciclo → pula". Quem paga dia 12 a
// parcela que venceu dia 10 NÃO adiantou a do mês que vem.
console.log('── 4. pagamento atrasado não apaga a próxima ──');
{
  const d = { dia_vencimento: 10, status: 'ativa', ultimo_pagamento: '2026-07-12' };
  const r = proximoVencimento(d, '2026-08-07');
  eq(r.data, '2026-08-10', 'pagou julho atrasado → agosto CONTINUA vencendo');
  eq(r.dias, 3, 'segue "em 3 dias"');
  ok(!r.quitadaNoCiclo, 'e não marca como quitada no ciclo');
}
console.log('  ok');

// ── 5. Regressão zero: sem pagamento, resultado idêntico ao de antes ─────
// Espelha a regra ANTIGA (a que rodava no card/cron) pra provar que dívida
// sem histórico de pagamento — TODAS as do Open Finance — não muda de valor.
console.log('── 5. sem histórico = comportamento antigo (Open Finance) ──');
{
  const regraAntiga = (dv, hojeStr) => {
    const [Y, M, D] = hojeStr.split('-').map(Number);
    const venc = new Date(Y, M - 1, dv.dia_vencimento);
    if (dv.dia_vencimento < D) venc.setMonth(venc.getMonth() + 1);
    if (dv.data_inicio) {
      const ini = new Date(dv.data_inicio + 'T00:00:00');
      if (venc.getTime() <= ini.getTime()) venc.setMonth(venc.getMonth() + 1);
    }
    const y = venc.getFullYear(); const m = venc.getMonth() + 1; const dd = venc.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  };

  // Casos reais da base (dívidas OF do Nubank) + varredura ampla.
  const casos = [
    { dia_vencimento: 10, data_inicio: '2026-07-07', status: 'ativa' },   // Credito Pessoal 8.500
    { dia_vencimento: 6,  data_inicio: '2026-05-08', status: 'ativa' },   // Credito Pessoal 8.000
    { dia_vencimento: 1,  data_inicio: null,         status: 'ativa' },
    { dia_vencimento: 28, data_inicio: null,         status: 'em_atraso' },
  ];
  const hojes = ['2026-08-07', '2026-08-01', '2026-08-31', '2026-01-15', '2026-12-30'];
  let comparados = 0;
  for (const c of casos) {
    for (const h of hojes) {
      const novo = proximoVencimento({ ...c, ultimo_pagamento: null }, h);
      eq(novo.data, regraAntiga(c, h), `sem pagamento, dia ${c.dia_vencimento} em ${h} tem de bater com a regra antiga`);
      comparados++;
    }
  }
  ok(comparados === 20, `comparou os 20 casos (veio ${comparados})`);
}
console.log('  ok');

// ── 6. Bordas ────────────────────────────────────────────────────────────
console.log('── 6. bordas ──');
{
  eq(proximoVencimento({ dia_vencimento: 10, status: 'quitada' }, '2026-08-07'), null, 'quitada não tem próximo vencimento');
  eq(proximoVencimento({ dia_vencimento: null, status: 'ativa' }, '2026-08-07'), null, 'sem dia de vencimento → null');
  eq(proximoVencimento({ dia_vencimento: 0, status: 'ativa' }, '2026-08-07'), null, 'dia 0 é inválido');
  eq(proximoVencimento({ dia_vencimento: 32, status: 'ativa' }, '2026-08-07'), null, 'dia 32 é inválido');
  eq(proximoVencimento(null, '2026-08-07'), null, 'dívida nula não quebra');

  // Vence hoje.
  const hoje = proximoVencimento({ dia_vencimento: 7, status: 'ativa' }, '2026-08-07');
  eq(hoje.dias, 0, 'vencimento hoje → 0 dias');

  // Mês curto: dívida que vence dia 31 em fevereiro.
  const fev = proximoVencimento({ dia_vencimento: 31, status: 'ativa' }, '2026-02-10');
  eq(fev.data, '2026-02-28', 'dia 31 em fevereiro vence em 28/02');
  // E o mês seguinte volta pro 31 (o clamp não pode "grudar" no 28).
  const marco = proximoVencimento({ dia_vencimento: 31, status: 'ativa', ultimo_pagamento: '2026-02-27' }, '2026-02-10');
  eq(marco.data, '2026-03-31', 'depois de pagar a de fevereiro, a próxima volta pro dia 31');

  // 1ª parcela nunca vence no mês da compra.
  const nova = proximoVencimento({ dia_vencimento: 27, data_inicio: '2026-08-05', status: 'ativa' }, '2026-08-06');
  eq(nova.data, '2026-08-27', 'compra dia 05, vence dia 27 → ainda cabe neste mês');
  const recem = proximoVencimento({ dia_vencimento: 27, data_inicio: '2026-08-27', status: 'ativa' }, '2026-08-26');
  eq(recem.data, '2026-09-27', 'parcelou no próprio dia 27 → 1ª parcela só no mês seguinte');
}
console.log('  ok');

// ── 7. Ciclos consecutivos: pagar sempre mantém o ritmo mensal ──────────
console.log('── 7. ritmo mensal ao longo do ano ──');
{
  let hoje = '2026-01-05';
  const datas = [];
  for (let i = 0; i < 12; i++) {
    const r = proximoVencimento({ dia_vencimento: 10, status: 'ativa', ultimo_pagamento: i ? datas[i - 1] : null }, hoje);
    datas.push(r.data);
    hoje = r.data;            // "paga" no dia do vencimento e segue
  }
  const meses = datas.map((d) => d.slice(0, 7));
  eq(new Set(meses).size, 12, 'pagando todo mês, cada vencimento cai num mês diferente (sem repetir nem pular)');
  eq(datas[0], '2026-01-10', 'começa em janeiro');
  eq(datas[11], '2026-12-10', 'termina em dezembro');
}
console.log('  ok');

// ── 8. emAtraso: o BADGE do card ─────────────────────────────────────────
//
// BUG DE ORIGEM: quatro dívidas pagas no mesmo dia continuavam com o selo
// "EM ATRASO" enquanto a linha logo abaixo, no MESMO card, dizia
// "Parcela paga · próxima em 36 dias". O selo lia a coluna `status`, que o
// cron escrevia e ninguém nunca apagava.
//
// ⚠️ E O TESTE ÓBVIO ESTÁ ERRADO: usar `quitadaNoCiclo` aqui só limparia o
// selo de quem pagou ADIANTADO. Quem paga NO DIA ou COM ATRASO — exatamente
// quem acabou de se acertar e vai olhar o selo — continuaria marcado.
console.log('── 8. emAtraso (selo do card) ──');
{
  const casos = [
    ['pagou adiantado, antes de vencer',      { dia_vencimento: 10, ultimo_pagamento: '2026-09-04' }, '2026-09-04', false],
    ['pagou mês passado, este ainda não veio', { dia_vencimento: 10, ultimo_pagamento: '2026-08-07' }, '2026-09-04', false],
    ['pagou NO DIA do vencimento',            { dia_vencimento: 10, ultimo_pagamento: '2026-09-10' }, '2026-09-10', false],
    ['pagou ATRASADO (se acertou hoje)',      { dia_vencimento: 10, ultimo_pagamento: '2026-09-15' }, '2026-09-15', false],
    ['atraso REAL: último pgto cobre 10/07',  { dia_vencimento: 10, ultimo_pagamento: '2026-07-07' }, '2026-09-04', true],
    ['sem pagamento registrado (Open Finance)', { dia_vencimento: 10, ultimo_pagamento: null },       '2026-09-04', false],
    ['quitada nunca atrasa',                  { dia_vencimento: 10, ultimo_pagamento: '2020-01-01', status: 'quitada' }, '2026-09-04', false],
    ['antes da 1ª parcela (contrato deste mês)', { dia_vencimento: 10, data_inicio: '2026-09-01', ultimo_pagamento: '2026-09-02' }, '2026-09-20', false],
  ];
  for (const [nome, divida, hoje, esperado] of casos) {
    eq(emAtraso(divida, hoje), esperado, `emAtraso — ${nome}`);
  }
}
console.log('  ok');

// ── Resultado ────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ vencimento de dívida: todos os casos passaram');
