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
  proximoVencimento, vencimentoCoberto, ocorrencia, diffDias, emAtraso, vencidaNoMes, statusDeAtraso, statusPorParcelas,
  parcelasEmAtraso, MAX_PARCELAS_ATRASO,
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

// ── O SELO "EM ATRASO" (vencidaNoMes / statusDeAtraso) ────────────────────
// Relato (set/2026): "mudei o vencimento do dia 15 pro 20 e continua em
// atraso". O cron marcava e nada desmarcava; e o teste dele (`pago < venc`)
// punia quem pagou adiantado.
console.log('── selo em atraso ──');
{
  const H = '2026-09-18';
  const casos = [
    ['dia 15 sem pagamento → atrasada', { dia_vencimento: 15, status: 'ativa' }, true],
    ['MUDOU pro dia 20 → não venceu ainda', { dia_vencimento: 20, status: 'em_atraso' }, false],
    ['vence HOJE não é atraso', { dia_vencimento: 18 }, false],
    ['pagou ADIANTADO dia 7 a do dia 10 → em dia', { dia_vencimento: 10, ultimo_pagamento: '2026-09-07' }, false],
    ['pagou dia 12 a do dia 10 (atrasado, mas pagou) → em dia', { dia_vencimento: 10, ultimo_pagamento: '2026-09-12' }, false],
    ['pagou só a de agosto → setembro atrasada', { dia_vencimento: 10, ultimo_pagamento: '2026-08-09' }, true],
    ['contratada DEPOIS do vencimento do mês → não atrasada', { dia_vencimento: 10, data_inicio: '2026-09-15' }, false],
    ['contratada no próprio dia do vencimento → não atrasada', { dia_vencimento: 10, data_inicio: '2026-09-10' }, false],
    ['todas as parcelas pagas → não atrasada', { dia_vencimento: 10, parcelas_total: 4, parcelas_pagas: 4 }, false],
    ['quitada nunca', { dia_vencimento: 10, status: 'quitada' }, false],
    ['banco diz que a próxima é mês que vem → não atrasada', { dia_vencimento: 10, proximo_vencimento: '2026-10-10' }, false],
    ['sem dia de vencimento → nunca', { status: 'ativa' }, false],
  ];
  for (const [nome, d, esperado] of casos) eq(vencidaNoMes(d, H), esperado, `vencidaNoMes — ${nome}`);

  eq(statusDeAtraso({ dia_vencimento: 20, status: 'em_atraso' }, H), 'ativa', 'status: em_atraso volta pra ativa');
  eq(statusDeAtraso({ dia_vencimento: 15, status: 'ativa' }, H), 'em_atraso', 'status: ativa vira em_atraso');
  eq(statusDeAtraso({ dia_vencimento: 15, status: 'quitada' }, H), 'quitada', 'status: quitada nunca é mexida');
  eq(statusDeAtraso({ dia_vencimento: 15, status: 'cancelada' }, H), 'cancelada', 'status: outro valor nunca é mexido');
}
console.log('  ok');

// ── ATRASADA ATÉ PAGAR (parcelasEmAtraso) ──────────────────────────────────
// Relato do Fábio (18/11/2026), o mesmo do cartão: "não paguei e no outro mês
// não mostrava em atraso". `vencidaNoMes` só olha o vencimento do MÊS CORRENTE:
// a parcela de 10/10 não paga deixava de ser atraso em 1º/11.
console.log('── atrasada até pagar ──');
{
  // O caso do relato: pagou a de setembro, NÃO pagou a de outubro.
  const fabio = { dia_vencimento: 10, status: 'ativa', ultimo_pagamento: '2026-09-09' };
  eq(vencidaNoMes(fabio, '2026-11-05'), false, 'a regra antiga (do mês) NÃO via a de outubro em 05/11 — era o bug');
  eq(parcelasEmAtraso(fabio, '2026-11-05'),
    { desde: '2026-10-10', ultima: '2026-10-10', dias: 26, quantas: 1, ouMais: false, comPagamento: true },
    '⚠️ 05/11: a de 10/10 SEGUE atrasada (26 dias)');
  eq(statusDeAtraso(fabio, '2026-11-05'), 'em_atraso', '⚠️ o selo fica EM ATRASO na virada do mês');
  eq(parcelasEmAtraso(fabio, '2026-11-18'),
    { desde: '2026-10-10', ultima: '2026-11-10', dias: 39, quantas: 2, ouMais: false, comPagamento: true },
    '18/11: outubro E novembro em aberto — desde 10/10');
  eq(parcelasEmAtraso(fabio, '2026-10-10'), null, 'no dia do vencimento ainda não é atraso');
  eq(parcelasEmAtraso(fabio, '2026-10-11')?.quantas, 1, 'um dia depois já é');

  // Pagou ATRASADO (12/10 a de 10/10) → em dia; não conta duas vezes.
  eq(parcelasEmAtraso({ ...fabio, ultimo_pagamento: '2026-10-12' }, '2026-11-05'), null, 'pagou a de outubro atrasado → em dia');
  // Pagou ADIANTADO a de novembro (07/11) → em dia.
  eq(parcelasEmAtraso({ ...fabio, ultimo_pagamento: '2026-11-07' }, '2026-11-18'), null, 'pagou adiantado → em dia');

  // ⚠️ SEM PAGAMENTO REGISTRADO = EXATAMENTE COMO ANTES (só o mês corrente).
  // Protege o relato "mudei do dia 15 pro 20 e continua em atraso" e quem paga
  // por fora sem registrar.
  eq(parcelasEmAtraso({ dia_vencimento: 20, status: 'em_atraso' }, '2026-09-18'), null, '⚠️ sem pagamento e o do mês não venceu → NÃO é atraso (caso "mudei pro dia 20")');
  eq(statusDeAtraso({ dia_vencimento: 20, status: 'em_atraso' }, '2026-09-18'), 'ativa', '⚠️ e o selo continua saindo');
  eq(parcelasEmAtraso({ dia_vencimento: 10, status: 'ativa' }, '2026-11-18'),
    { desde: '2026-11-10', ultima: '2026-11-10', dias: 8, quantas: 1, ouMais: false, comPagamento: false },
    'sem pagamento: só a parcela DESTE mês (como sempre foi)');

  // Contrato: nada antes do início.
  eq(parcelasEmAtraso({ dia_vencimento: 10, ultimo_pagamento: '2026-08-10', data_inicio: '2026-09-15' }, '2026-11-18')?.quantas, 2,
    'para no data_inicio: setembro (antes do contrato) não conta');
  eq(parcelasEmAtraso({ dia_vencimento: 10, ultimo_pagamento: '2026-08-10', data_inicio: '2026-11-12' }, '2026-11-18'), null,
    'contrato depois do último vencimento → nada vencido');
  // Teto pelas parcelas que faltam.
  eq(parcelasEmAtraso({ dia_vencimento: 10, ultimo_pagamento: '2026-05-10', parcelas_total: 3, parcelas_pagas: 2 }, '2026-11-18')?.quantas, 1,
    'nunca mais atrasadas do que as que faltam pagar');
  // Teto da janela.
  const velha = parcelasEmAtraso({ dia_vencimento: 10, ultimo_pagamento: '2024-01-10' }, '2026-11-18');
  eq([velha?.quantas, velha?.ouMais], [MAX_PARCELAS_ATRASO, true], 'muito tempo sem pagar: para no teto e diz "ou mais"');
  // Travas que já existiam.
  eq(parcelasEmAtraso({ ...fabio, status: 'quitada' }, '2026-11-18'), null, 'quitada nunca');
  eq(parcelasEmAtraso({ ...fabio, parcelas_total: 10, parcelas_pagas: 10 }, '2026-11-18'), null, 'todas pagas nunca');
  eq(parcelasEmAtraso({ ...fabio, proximo_vencimento: '2026-12-10' }, '2026-11-18'), null, 'banco diz que a próxima é mês que vem → não');
  eq(parcelasEmAtraso({ ...fabio, dia_vencimento: null }, '2026-11-18'), null, 'sem dia → nunca');
  // Mês curto: dia 31 vence em 28/02.
  eq(parcelasEmAtraso({ dia_vencimento: 31, ultimo_pagamento: '2026-01-30' }, '2026-03-05')?.desde, '2026-02-28', 'dia 31 → a de fevereiro é 28/02');
  // Vence hoje não entra na conta.
  eq(parcelasEmAtraso({ dia_vencimento: 18, ultimo_pagamento: '2026-09-17' }, '2026-11-18'),
    { desde: '2026-10-18', ultima: '2026-10-18', dias: 31, quantas: 1, ouMais: false, comPagamento: true },
    'a de HOJE (18/11) não conta como atrasada; a de 18/10 sim');

  // ── PROVA DE NÃO-REGRESSÃO: regra antiga (vencidaNoMes) × nova, dia a dia ──
  // Em toda combinação: (1) o que era atraso continua; (2) sem pagamento é
  // IDÊNTICO; (3) a única diferença é a pretendida.
  let casos = 0; let novos = 0;
  const viol = [];
  const dias = [1, 5, 10, 15, 18, 28, 29, 30, 31];
  const pagamentos = [null, '2025-12-20', '2026-03-09', '2026-06-01', '2026-06-30', '2026-09-12', '2026-10-28', '2026-12-31'];
  const inicios = [null, '2025-11-15', '2026-05-20', '2026-10-01'];
  for (let t = Date.UTC(2026, 0, 1); t <= Date.UTC(2027, 1, 28); t += 86400000) {
    const hoje = new Date(t).toISOString().slice(0, 10);
    for (const dia of dias) for (const ultimo_pagamento of pagamentos) for (const data_inicio of inicios) {
      if (ultimo_pagamento && ultimo_pagamento > hoje) continue;
      const d = { dia_vencimento: dia, status: 'ativa', ultimo_pagamento, data_inicio };
      const antiga = vencidaNoMes(d, hoje);
      const nova = !!parcelasEmAtraso(d, hoje);
      casos++;
      if (antiga && !nova) viol.push(`(1) deixou de ser atraso: ${JSON.stringify(d)} ${hoje}`);
      if (!ultimo_pagamento && antiga !== nova) viol.push(`(2) sem pagamento mudou: ${JSON.stringify(d)} ${hoje}`);
      if (nova && !antiga) {
        novos++;
        const venceEsteMes = ocorrencia(+hoje.slice(0, 4), +hoje.slice(5, 7) - 1, dia);
        if (!ultimo_pagamento || venceEsteMes < hoje) viol.push(`(3) diferença fora do previsto: ${JSON.stringify(d)} ${hoje}`);
      }
    }
  }
  eq(viol.slice(0, 3), [], `⚠️ não-regressão em ${casos} combinações (${novos} viram atraso — todas antes do vencimento do mês, com pagamento registrado)`);
  ok(novos > 0, 'a varredura exercita o caso novo');
}
console.log('  ok');

// ── 7. REABRIR DIVIDA: status pelas PARCELAS ──────────────────────────────
//
// Relato (set/2026): o cliente quitou uma parcela sem querer, editou baixando
// as pagas de 3 pra 2, e o card CONTINUOU "Quitada". O POST sempre recalculou
// o status pelas parcelas; o PUT nunca, e `statusDeAtraso` devolve 'quitada'
// intacta de proposito. Medido: 3 dividas na base nesse estado.
console.log('── 7. status pelas parcelas (reabrir) ──');
{
  eq(statusPorParcelas({ parcelas_pagas: 2, parcelas_total: 3 }), 'ativa',   'parcela a menos REABRE');
  eq(statusPorParcelas({ parcelas_pagas: 3, parcelas_total: 3 }), 'quitada', 'todas pagas = quitada');
  eq(statusPorParcelas({ parcelas_pagas: 4, parcelas_total: 3 }), 'quitada', 'pagas acima do total segue quitada');
  eq(statusPorParcelas({ parcelas_pagas: 0, parcelas_total: 3 }), 'ativa',   'nenhuma paga = ativa');

  // ⚠️ O CASO QUE PROTEGE O RESTO DA BASE: divida SEM parcelas e quitada pelo
  // botao "quitar tudo". Responder 'ativa' aqui desquitaria todas elas na
  // primeira edicao — ate numa troca de titulo. `null` = nao mexa.
  eq(statusPorParcelas({ parcelas_pagas: 0, parcelas_total: null }), null, 'sem parcelas: nao opina');
  eq(statusPorParcelas({ parcelas_pagas: 5, parcelas_total: 0 }),    null, 'total zero: nao opina');
  eq(statusPorParcelas({}),                                          null, 'objeto vazio: nao opina');
  eq(statusPorParcelas(null),                                        null, 'null: nao opina');

  // Texto vindo do payload do painel (input numerico devolve string).
  eq(statusPorParcelas({ parcelas_pagas: '2', parcelas_total: '3' }), 'ativa', 'numero em texto');
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
