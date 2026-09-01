// =============================================================================
// EVAL do VALOR EXIBIDO da fatura (services/faturaVista.js).
//
// É a regra que decide o número que o cliente vê no card do cartão. Errar aqui
// não dá erro em lugar nenhum: dá um valor plausível e ERRADO, que ele compara
// com o app do banco e conclui que a Sora não presta. Já aconteceu três vezes:
//
//   · app R$ 1.035,55 × banco R$ 1.788,00  (transação faltando na soma)
//   · app R$ 3.190,81 × banco R$   560,68  (somou o ciclo em vez do banco)
//   · app R$   560,68 na fatura de SETEMBRO (simulado pendurado na competência
//                                            errada — era a de agosto)
//
// A ordem de prioridade que este eval trava:
//   1. fatura PUBLICADA pelo banco   → manda, sempre
//   2. SIMULADA, só na competência a que ela pertence (a seguinte à última
//      publicada — não necessariamente a "atual")
//   3. soma do ciclo + parcelas previstas
//
// Rodar:  npm run eval:fatura-vista
// =============================================================================
const { valorExibido } = require('../src/services/faturaVista');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

// Cartão real do caso do Mercado Pago: fecha 8, vence 13.
const CARTAO_OF = { id: 'c1', of_conta_id: 'of1', dia_fechamento: 8, dia_vencimento: 13, saldo: -560.68 };
const CARTAO_MANUAL = { id: 'c2', of_conta_id: null, dia_fechamento: 8, dia_vencimento: 13, saldo: 0 };

// `st` = saída do statusFatura (soma do NOSSO ciclo).
const st = (fatura, pago = 0, ciclo = {}) => ({
  fatura, pago, restante: Math.max(0, fatura - pago),
  ciclo: { ini: '2026-07-09', fim: '2026-08-08', venc: '2026-08-13', ...ciclo },
});

const semDeps = { faturasBanco: async () => [], parcelasPrevistas: async () => ({ total: 0 }) };

// Tudo roda dentro de um async: `valorExibido` é assíncrona (lê of_faturas).
async function main() {

// ── 1. Fatura publicada pelo banco MANDA ────────────────────────────────
console.log('── 1. banco publicou → é o valor ──');
{
  const deps = {
    faturasBanco: async () => [{ competencia: '2026-08', total: 1788, pago: 0, vencimento: '2026-08-13' }],
    parcelasPrevistas: async () => ({ total: 0 }),
  };
  // A soma do nosso ciclo daria 1035,55 — o caso do relato. O banco diz 1788.
  const v = await valorExibido(CARTAO_OF, '2026-08', st(1035.55), deps);
  eq(v.fatura, 1788, 'usa o total do banco, não a nossa soma');
  eq(v.fonte, 'banco', 'a fonte é o banco');
  ok(v.doBanco === true, 'marcado como valor do banco');

  // Com pagamento parcial registrado NA FATURA do banco.
  const deps2 = {
    faturasBanco: async () => [{ competencia: '2026-08', total: 1788, pago: 788, vencimento: '2026-08-13' }],
    parcelasPrevistas: async () => ({ total: 0 }),
  };
  const v2 = await valorExibido(CARTAO_OF, '2026-08', st(1035.55), deps2);
  eq(v2.fatura, 1788, 'total continua sendo o total');
  eq(v2.restante, 1000, 'restante = total − pago');
  eq(v2.quitada, false, 'pagamento parcial não quita');

  const deps3 = {
    faturasBanco: async () => [{ competencia: '2026-08', total: 1788, pago: 1788, vencimento: '2026-08-13' }],
    parcelasPrevistas: async () => ({ total: 0 }),
  };
  const v3 = await valorExibido(CARTAO_OF, '2026-08', st(1035.55), deps3);
  eq(v3.restante, 0, 'pago por inteiro → restante zero');
  eq(v3.quitada, true, 'e quitada');
}
console.log('  ok');

// ── 2. O SIMULADO só vale na competência dele ───────────────────────────
console.log('── 2. simulado na competência certa ──');
{
  // Última fatura publicada = julho (venc 13/07). Logo o simulado (560,68) é
  // do ciclo SEGUINTE = agosto. Esse é o caso real do Mercado Pago.
  const deps = {
    faturasBanco: async () => [{ competencia: '2026-07', total: 900, pago: 900, vencimento: '2026-07-13' }],
    // Fiel à projeção real: fatura JÁ FECHADA (agosto, aqui) nunca tem parcela
    // prevista — `projetar` só emite da competência atual pra frente.
    parcelasPrevistas: async (_id, comp) => ({ total: comp === '2026-09' ? 276.52 : 0 }),
  };

  const ago = await valorExibido(CARTAO_OF, '2026-08', st(3190.81), deps);
  eq(ago.fatura, 560.68, 'agosto (ciclo seguinte ao publicado) recebe o SIMULADO');
  eq(ago.fonte, 'simulada', 'fonte simulada');
  ok(ago.fatura !== 3190.81, 'e NÃO a soma do ciclo, que era o número errado da tela');

  // Setembro NÃO pode receber o simulado — é uma fatura à frente.
  const set = await valorExibido(CARTAO_OF, '2026-09', st(282.27), deps);
  ok(set.fonte !== 'simulada', 'setembro não pega o simulado (é de agosto)');
  eq(set.fatura, 558.79, 'setembro = soma do ciclo + parcelas previstas');
  eq(set.fonte, 'ciclo+previstas', 'fonte é ciclo+previstas');

  // Julho (já publicada) continua vindo do banco, não do simulado.
  const jul = await valorExibido(CARTAO_OF, '2026-07', st(999), deps);
  eq(jul.fatura, 900, 'julho vem da fatura publicada');
  eq(jul.fonte, 'banco', 'fonte banco');
}
console.log('  ok');

// ── 2B. O SIMULADO MANDA SOZINHO ────────────────────────────────────────
//
// ⚠️ ESTE BLOCO JÁ AFIRMOU O CONTRÁRIO E ESTAVA ERRADO. A hipótese era que o
// simulado ("soma dos débitos SEM fatura no ciclo") não incluísse parcela a
// vencer, e por isso somávamos a projeção nele. Medido depois numa conta real:
// simulado R$ 1.774,64 — que bate AO CENTAVO com a regra de ouro
// (`used_amount − unbilled_amount`) e com o que a cliente leu no app do banco.
// Somando as parcelas projetadas a fatura ia pra R$ 2.716,75, ou seja, a Sora
// contradizendo o banco — que é o que este arquivo existe pra impedir.
//
// Onde o simulado DIFERE da nossa soma de transações, ele já traz o que a
// gente não tem; somar por cima conta duas vezes. O banco é a FONTE — a
// projeção só preenche onde a fonte não existe (§3, ramo `ciclo+previstas`).
console.log('── 2B. simulado passa intacto ──');
{
  const CARTAO_ITAU = { id: 'c-itau', of_conta_id: 'x', dia_fechamento: 4, dia_vencimento: 11, saldo: -218.70 };
  const deps = {
    faturasBanco: async () => [{ competencia: '2026-08', total: 2753.80, pago: 0, vencimento: '2026-08-11' }],
    parcelasPrevistas: async (_id, comp) => ({ total: comp === '2026-09' ? 347.52 : 0 }),
  };

  const set = await valorExibido(CARTAO_ITAU, '2026-09', st(218.70), deps);
  eq(set.fatura, 218.70, 'o simulado passa intacto, mesmo havendo parcela projetada');
  eq(set.fonte, 'simulada', 'origem: simulada, sem soma');
  ok(set.doBanco, 'é número do banco, não reconstrução nossa');

  // O caso que derrubou a hipótese, com os números reais: simulado 1.774,64 e
  // 942,11 de parcelas projetadas na mesma competência.
  const ANA = { id: 'c-ana', of_conta_id: 'x', dia_fechamento: 3, dia_vencimento: 10, saldo: -1774.64 };
  const depsAna = {
    faturasBanco: async () => [{ competencia: '2026-08', total: 1303.06, pago: 1303.06, vencimento: '2026-08-10' }],
    parcelasPrevistas: async () => ({ total: 942.11 }),
  };
  const ana = await valorExibido(ANA, '2026-09', st(1390.14), depsAna);
  eq(ana.fatura, 1774.64, 'a fatura é o simulado do banco, não simulado + previstas');
  ok(ana.fatura !== 2716.75, 'nunca mais R$ 2.716,75');

  // Sem parcela nenhuma o resultado é o mesmo — o simulado não depende disso.
  const semParcela = { faturasBanco: deps.faturasBanco, parcelasPrevistas: async () => ({ total: 0 }) };
  const puro = await valorExibido(CARTAO_ITAU, '2026-09', st(218.70), semParcela);
  eq(puro.fatura, 218.70, 'sem parcela prevista, idêntico');
  eq(puro.fonte, 'simulada', 'origem simulada');

  // A fatura publicada continua mandando — nunca somar por cima dela (o banco
  // já cobrou a parcela dentro do total dele).
  const ago = await valorExibido(CARTAO_ITAU, '2026-08', st(2406.28), deps);
  eq(ago.fatura, 2753.80, 'fatura publicada não recebe soma de parcela');
  eq(ago.fonte, 'banco', 'fonte banco');
}
console.log('  ok');

// ── 3. Sem NENHUMA fatura publicada → simulado na competência atual ─────
console.log('── 3. sem fatura publicada (fallback) ──');
{
  // Não dá pra saber a que ciclo o simulado pertence sem uma publicada de
  // referência. Aí vale o melhor palpite: a competência atual. É o
  // comportamento antigo — mantido de propósito pra não piorar quem já estava
  // assim (cartão recém-conectado, banco que nunca publicou nada).
  const deps = {
    faturasBanco: async () => [],
    parcelasPrevistas: async () => ({ total: 0 }),
  };
  const { competenciaAtual } = require('../src/services/cicloFatura');
  const atual = competenciaAtual(CARTAO_OF);
  const v = await valorExibido(CARTAO_OF, atual, st(3190.81), deps);
  eq(v.fatura, 560.68, 'sem publicada, o simulado assume a competência atual');
  eq(v.fonte, 'simulada', 'fonte simulada');
}
console.log('  ok');

// ── 4. Cartão MANUAL não muda nada ──────────────────────────────────────
console.log('── 4. cartão manual intocado ──');
{
  const v = await valorExibido(CARTAO_MANUAL, '2026-08', st(1200, 200), semDeps);
  eq(v.fatura, 1200, 'manual = soma do ciclo');
  eq(v.pago, 200, 'pago do nosso livro');
  eq(v.restante, 1000, 'restante = fatura − pago');
  eq(v.fonte, 'ciclo', 'fonte é o ciclo');
  ok(v.doBanco === false, 'não é valor de banco');

  // ⚠️ Cartão manual NUNCA pode ler of_faturas: ele não tem fatura publicada,
  // e se lesse por engano a de outro cartão o valor viria de lugar nenhum.
  let leu = false;
  await valorExibido(CARTAO_MANUAL, '2026-08', st(1200), {
    faturasBanco: async () => { leu = true; return []; },
    parcelasPrevistas: async () => ({ total: 0 }),
  });
  eq(leu, false, 'manual não consulta as faturas do banco');
}
console.log('  ok');

// ── 5. Bordas ───────────────────────────────────────────────────────────
console.log('── 5. bordas ──');
{
  // Fatura publicada com total ZERO é resposta VÁLIDA (fatura quitada/vazia) —
  // não pode cair no simulado por ser "falsy".
  const deps = {
    faturasBanco: async () => [{ competencia: '2026-08', total: 0, pago: 0 }],
    parcelasPrevistas: async () => ({ total: 0 }),
  };
  const v = await valorExibido(CARTAO_OF, '2026-08', st(3190.81), deps);
  eq(v.fatura, 0, 'total 0 do banco é 0, não "sem valor"');
  eq(v.fonte, 'banco', 'e a fonte segue sendo o banco');
  eq(v.quitada, false, 'fatura zerada não é "quitada" — não há o que encerrar');

  // Saldo ZERO não é fatura zerada: é o banco não ter publicado o simulado.
  const semSaldo = { ...CARTAO_OF, saldo: 0 };
  const v2 = await valorExibido(semSaldo, '2026-09', st(282.27), {
    faturasBanco: async () => [{ competencia: '2026-08', total: 100, pago: 0 }],
    parcelasPrevistas: async () => ({ total: 276.52 }),
  });
  eq(v2.fonte, 'ciclo+previstas', 'saldo 0 não vira fatura 0 — soma o ciclo');
  eq(v2.fatura, 558.79, 'e o valor é a soma + previstas');

  // Falha ao ler as faturas do banco (migration 118 pendente) não pode
  // derrubar nada — cai no comportamento anterior.
  const v3 = await valorExibido(CARTAO_OF, '2026-08', st(3190.81), {
    faturasBanco: async () => [],
    parcelasPrevistas: async () => ({ total: 0 }),
  });
  ok(v3.fatura > 0, 'sem a tabela 118 ainda devolve um valor');
}
console.log('  ok');

// ── 6. O SIMULADO QUE É, NA VERDADE, O LIMITE USADO ───────────────────────
//
// ⚠️ Caso REAL (Inter, set/2026) — relato do cliente: "a fatura está como se
// fosse o limite usado do cartão e não a fatura real". O payload cru confirmou:
//
//     used_amount ..... R$ 10.217,60
//     unbilled_amount . R$ 0,00        ← o emissor manda ZERO
//     ciclo aberto .... 1 compra de R$ 180, sem bill_id
//     histórico ....... 24 faturas entre R$ 135 e R$ 870
//
// Com `unbilled = 0` a regra de ouro (`used − unbilled`) degenera e devolve o
// limite usado cru. A Sora exibia R$ 10.217,60 num cartão cuja fatura típica é
// R$ 640 — dezesseis vezes.
//
// O que denuncia o dado ruim é a CONTRADIÇÃO: o emissor dizer que nada está sem
// faturar enquanto o ciclo ABERTO tem lançamento. Compra em ciclo aberto é, por
// definição, não faturada.
//
// Medido na base: 3 de 42 cartões de OF mudam, todos PRA BAIXO (o limite usado
// infla). O do relato foi de R$ 10.217,60 pra R$ 568,93 = GOL 180 (1/3) + azul
// seguros 388,93 (8/10) — coerente com o histórico do cartão.
console.log('── 6. simulado igual ao limite usado ──');
{
  const inter = {
    id: 'inter', of_conta_id: 'of-inter',
    dia_fechamento: 3, dia_vencimento: 10,
    saldo: -10217.60, of_limite_usado: 10217.60,
  };

  // Com movimento no ciclo → o simulado é recusado e cai no auditável.
  const comMovimento = await valorExibido(inter, '2026-09', st(568.93), semDeps);
  ok(comMovimento.fatura !== 10217.60, 'NÃO exibe o limite usado como fatura');
  eq(comMovimento.fonte, 'ciclo+previstas', 'cai no caminho auditável');

  // ⚠️ SEM movimento no ciclo, `unbilled = 0` é LEGÍTIMO (a fatura fechou e
  // ninguém comprou desde então) — e aí o simulado continua valendo. Sem esta
  // metade, a trava viraria "nunca confie no simulado", que é o oposto do que
  // este arquivo inteiro defende.
  const semMovimento = await valorExibido(inter, '2026-09', st(0), semDeps);
  eq(semMovimento.fatura, 10217.60, 'ciclo vazio: o simulado segue valendo');
  eq(semMovimento.fonte, 'simulada', 'e a fonte continua sendo o banco');

  // Simulado DIFERENTE do limite usado = a regra de ouro funcionou. Intocado.
  const regraFechou = { ...inter, saldo: -1774.64, of_limite_usado: 3155.80 };
  const normal = await valorExibido(regraFechou, '2026-09', st(900), semDeps);
  eq(normal.fatura, 1774.64, 'regra de ouro que fechou continua mandando');

  // Sem `of_limite_usado` não há com o que comparar — adota o simulado.
  const semUsado = { ...inter, of_limite_usado: null };
  const r4 = await valorExibido(semUsado, '2026-09', st(180), semDeps);
  eq(r4.fatura, 10217.60, 'sem limite usado gravado, nada muda');
}
console.log('  ok');

} // fim do main

// ── Resultado ────────────────────────────────────────────────────────────
main().then(() => {
  console.log('');
  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ valor exibido da fatura: todos os casos passaram');
}).catch((e) => { console.error('✗ eval quebrou:', e); process.exit(1); });
