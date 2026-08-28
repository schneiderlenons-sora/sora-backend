// =============================================================================
// EVAL da aritmética do Oráculo (services/saudeCompra).
//
// Aqui um erro não é um número feio na tela: é a Sora dizendo "pode comprar"
// pra quem não pode, e a pessoa assumindo 10 meses de parcela em cima disso.
// Cada seção trava uma decisão que, se invertida, produz exatamente esse erro.
//
// Rodar:  npm run eval:saude-compra
// =============================================================================
const {
  avaliarCompra, calcularRenda, calcularSaida, limiteDisponivel, mediana,
} = require('../src/services/saudeCompra');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

const R = (reais) => Math.round(reais * 100);   // reais → centavos

// ── 1. Renda ───────────────────────────────────────────────────────────────
console.log('── 1. renda ──');
{
  // Receita fixa cadastrada ganha do histórico: a pessoa AFIRMOU o valor.
  const fixa = calcularRenda([{ valor: R(5000) }, { valor: R(1500) }], [R(3000), R(3000), R(3000)]);
  eq(fixa.valor, R(6500), 'soma as receitas fixas');
  eq(fixa.fonte, 'fixa', 'fonte fixa tem prioridade sobre o histórico');
  eq(fixa.estavel, true, 'receita fixa é estável por definição');

  // Histórico estável (≤20% de variação) → mediana.
  const est = calcularRenda([], [R(6000), R(6200), R(6100)]);
  eq(est.fonte, 'historico', 'cai no histórico sem receita fixa');
  eq(est.estavel, true, 'variação baixa = estável');
  eq(est.valor, R(6100), 'estável usa a MEDIANA');

  // ⚠️ A REGRA QUE EVITA O "SIM" ERRADO: renda que oscila usa o PIOR mês.
  // Com a média, 26.121/12.542/11.630 daria ~R$16.700 e aprovaria parcela que
  // no mês ruim não cabe. (Números reais medidos na base.)
  const osc = calcularRenda([], [R(26121), R(12542), R(11630)]);
  eq(osc.estavel, false, 'variação alta = instável');
  eq(osc.valor, R(11630), 'renda instável usa o MENOR mês, não a média');
  ok(osc.valor < R(16764), 'o valor usado é menor que a média simples');

  // ⚠️ A FIXA NÃO TEM PRIORIDADE — é o MAIOR dos dois. Medido na base: há
  // recorrências de Recebimento de R$ 0,05, R$ 0,15 e R$ 29 (rendimento de
  // conta, cashback, cadastro de teste). Com prioridade pra fixa, uma dessas
  // virava "a renda" e o Oráculo dava um NÃO categórico a quem ganha bem.
  const lixo = calcularRenda([{ valor: R(0.05) }], [R(9000), R(9200), R(9100)]);
  eq(lixo.valor, R(9100), 'receita fixa irrisória não sequestra a renda');
  eq(lixo.fonte, 'historico', 'nesse caso a fonte é o histórico');

  // E o contrário também: fixa maior que o histórico continua ganhando (quem
  // cadastrou o salário mas quase não lança recebimento no app).
  const declarada = calcularRenda([{ valor: R(8000) }], [R(1000), R(1100), R(900)]);
  eq(declarada.valor, R(8000), 'fixa maior que o histórico prevalece');
  eq(declarada.fonte, 'fixa', 'fonte fixa');

  // Sem dado nenhum → null. É o que dispara o tier "não sei".
  eq(calcularRenda([], []).valor, null, 'sem receita fixa e sem histórico → null');
  eq(calcularRenda([], [R(5000), R(5000)]).valor, null, 'menos de 3 meses fechados → null');

  eq(mediana([1, 2, 3]), 2, 'mediana ímpar');
  eq(mediana([1, 2, 3, 4]), 3, 'mediana par (arredonda)');
}
console.log('  ok');

// ── 2. Saída — max, NUNCA soma ─────────────────────────────────────────────
console.log('── 2. saída (a contagem dupla) ──');
{
  // MEDIDO na base: 21 recorrências (R$1.807,43/mês) apontam pra cartão de
  // crédito. Elas viram transação NO CARTÃO e reaparecem dentro da fatura.
  // Somar os dois lados contaria esse dinheiro duas vezes.
  const s = calcularSaida(R(3000), R(4500));
  eq(s.valor, R(4500), 'pega o MAIOR dos dois, não a soma');
  ok(s.valor !== R(7500), 'não soma compromissos + histórico (seria contagem dupla)');
  eq(s.fonte, 'historico', 'nomeia de onde veio o número maior');

  const s2 = calcularSaida(R(5000), R(2000));
  eq(s2.valor, R(5000), 'compromissos futuros ganham quando são maiores');
  eq(s2.fonte, 'compromissos', 'fonte compromissos');

  eq(calcularSaida(0, 0).valor, 0, 'sem dado nenhum → 0');
}
console.log('  ok');

// ── 3. Limite do cartão — parcelado consome o TOTAL ────────────────────────
console.log('── 3. limite do cartão ──');
{
  eq(limiteDisponivel({ limite: R(5000), faturaAberta: R(800), parcelasFuturas: 0 }), R(4200),
     'limite − fatura em aberto');
  eq(limiteDisponivel({ limite: R(5000), faturaAberta: R(800), parcelasFuturas: R(1200) }), R(3000),
     'desconta também as parcelas futuras já comprometidas');
  eq(limiteDisponivel({ limite: R(1000), faturaAberta: R(1500), parcelasFuturas: 0 }), 0,
     'estourado não devolve negativo');

  // ⚠️ Sem limite cadastrado (10% dos cartões da base) NÃO se assume que cabe.
  eq(limiteDisponivel({ limite: 0, faturaAberta: 0, parcelasFuturas: 0 }), null, 'sem limite → null');
  eq(limiteDisponivel(null), null, 'sem cartão → null');

  // ⚠️ A regra que evita "cabe" numa compra que a máquina recusa: parcelamento
  // trava o limite INTEIRO na hora, não a parcela.
  const foto = {
    renda: { valor: R(10000), fonte: 'fixa', estavel: true, variacao: null },
    saida: calcularSaida(R(3000), R(3000)),
    caixa: R(20000),
    cartao: { nome: 'Nubank', limite: R(3000), faturaAberta: 0, parcelasFuturas: 0 },
    faturasEmDia: true,
  };
  const r = avaliarCompra({ total: R(5000), parcela: R(500), parcelas: 10, noCartao: true }, foto);
  eq(r.veredito, 'nao', 'R$5.000 em 10x NÃO cabe num limite de R$3.000');
  ok(r.numeros.parcela < r.numeros.limiteDisponivel,
     'a PARCELA caberia no limite — é justamente a leitura errada que o teste barra');
}
console.log('  ok');

// ── 4. Sem renda: nunca há veredito ────────────────────────────────────────
console.log('── 4. sem renda ──');
{
  const semRenda = {
    renda: calcularRenda([], []),
    saida: calcularSaida(R(2000), 0),
    caixa: R(5000),
    cartao: { nome: 'Nubank', limite: R(8000), faturaAberta: R(1000), parcelasFuturas: 0 },
    faturasEmDia: true,
  };
  const r = avaliarCompra({ total: R(3000), parcela: R(3000), parcelas: 1 }, semRenda);
  eq(r.veredito, null, 'sem renda NÃO devolve veredito');
  eq(r.tier, 'parcial', 'mas prova o que sabe (tier parcial)');
  ok(r.faltando.includes('renda'), 'nomeia que falta a renda');
  ok(r.motivos.some((m) => m.chave === 'caixa'), 'ainda assim informa o caixa');
  ok(!r.motivos.some((m) => m.chave === 'renda'), 'NÃO imprime marcador de renda que não tem');

  // Sem absolutamente nada → nem parcial.
  const nada = avaliarCompra({ total: R(3000), parcela: R(3000), parcelas: 1 }, {
    renda: calcularRenda([], []), saida: calcularSaida(0, 0), caixa: 0,
    cartao: null, faturasEmDia: null,
  });
  eq(nada.tier, 'nao_sei', 'sem nenhum dado → tier nao_sei');
  eq(nada.veredito, null, 'e sem veredito');

  // ⚠️ RENDA INCOERENTE = RENDA DESCONHECIDA, não pessoa quebrada.
  // Caso real da base: R$ 0,05 de receita cadastrada contra R$ 27.852 de saída
  // medida. Um "não" categórico aqui seria tão errado quanto um "sim" chutado.
  const incoerente = avaliarCompra({ total: R(5000), parcela: R(500), parcelas: 10 }, {
    renda: { valor: R(0.05), fonte: 'fixa', estavel: true, variacao: null },
    saida: calcularSaida(R(27852), 0),
    caixa: R(4000), cartao: null, faturasEmDia: true,
  });
  eq(incoerente.veredito, null, 'renda incoerente NÃO vira veredito');
  eq(incoerente.rendaIncoerente, true, 'a incoerência é sinalizada');
  ok(incoerente.faltando.includes('renda'), 'pede a renda');
  ok(!incoerente.motivos.some((m) => m.chave === 'renda'),
     'e NÃO imprime "Renda: R$ 0,05" ao lado de R$ 27.852 de saída');

  // Gastar mais do que ganha é REAL e continua virando veredito — o portão só
  // barra o que é implausível. Medido: os casos legítimos ficam em 75%–118%.
  const apertado = avaliarCompra({ total: R(5000), parcela: R(500), parcelas: 10 }, {
    renda: { valor: R(2563), fonte: 'historico', estavel: true, variacao: 0.1 },
    saida: calcularSaida(R(3398), 0),
    caixa: R(1000), cartao: null, faturasEmDia: true,
  });
  eq(apertado.tier, 'veredito', 'gastar 133% da renda ainda é um veredito legítimo');
  eq(apertado.veredito, 'nao', 'e o veredito é não');

  // ⚠️ Saída ZERO não é "não gasta nada" — é "não sei o que sai".
  // Caso real: conta com R$ 26,00 de receita cadastrada, sem despesa fixa e
  // sem histórico recebia um NÃO categórico só porque R$ 26 não cobrem a
  // compra. Não existe retrato financeiro nenhum ali.
  const semSaida = avaliarCompra({ total: R(200), parcela: R(200), parcelas: 1 }, {
    renda: { valor: R(26), fonte: 'fixa', estavel: true, variacao: null },
    saida: calcularSaida(0, 0), caixa: 0, cartao: null, faturasEmDia: null,
  });
  eq(semSaida.veredito, null, 'sem despesa conhecida NÃO há veredito');
  ok(semSaida.faltando.includes('despesas'), 'e nomeia que faltam as despesas');
}
console.log('  ok');

// ── 5. O critério conservador ──────────────────────────────────────────────
console.log('── 5. critério conservador ──');
{
  const base = (over = {}) => ({
    renda: { valor: R(8000), fonte: 'fixa', estavel: true, variacao: null },
    saida: calcularSaida(R(4000), R(4000)),          // folga = R$ 4.000
    caixa: R(20000),
    cartao: { nome: 'Nubank', limite: R(20000), faturaAberta: 0, parcelasFuturas: 0 },
    faturasEmDia: true,
    ...over,
  });

  // Parcela de R$500 em folga de R$4.000 = 12,5% → passa em tudo.
  const bom = avaliarCompra({ total: R(5000), parcela: R(500), parcelas: 10, noCartao: true }, base());
  eq(bom.veredito, 'pode', 'parcela pequena na folga → pode');
  ok(bom.numeros.ocupacao < 0.30, 'ocupação abaixo do teto');

  // R$1.600 de parcela em folga de R$4.000 = 40% → cabe, mas aperta.
  const aperta = avaliarCompra({ total: R(16000), parcela: R(1600), parcelas: 10, noCartao: true }, base());
  eq(aperta.veredito, 'cuidado', 'ocupa 40% da folga → cuidado, não "pode"');
  eq(aperta.regras.todoMesPositivo, true, 'ainda fecha positivo');
  eq(aperta.regras.ocupacao, false, 'mas estoura o teto de 30%');

  // Parcela maior que a folga → não fecha o mês.
  const nao = avaliarCompra({ total: R(50000), parcela: R(5000), parcelas: 10, noCartao: true }, base());
  eq(nao.veredito, 'nao', 'parcela maior que a folga → não');
  eq(nao.regras.todoMesPositivo, false, 'o mês fecha negativo');

  // ⚠️ Reserva: caixa baixo derruba pra "cuidado" mesmo com folga sobrando.
  const semReserva = avaliarCompra(
    { total: R(5000), parcela: R(500), parcelas: 10, noCartao: true },
    base({ caixa: R(100) }),
  );
  eq(semReserva.veredito, 'cuidado', 'sem reserva de 1 mês → cuidado');
  eq(semReserva.regras.reserva, false, 'a regra da reserva é a que falhou');

  // À vista tira o total do caixa na hora — a reserva tem de contar isso.
  const aVista = avaliarCompra(
    { total: R(19000), parcela: R(19000), parcelas: 1, noCartao: false },
    base(),
  );
  eq(aVista.regras.reserva, false, 'à vista: o total sai do caixa e come a reserva');

  // ⚠️ Fatura vencida NUNCA vira "pode comprar". A conta pode fechar na
  // planilha e a pessoa estar atrasada hoje — a resposta se contradiria
  // sozinha ("Pode comprar" + "⚠️ fatura vencida" na mesma tela).
  const atrasado = avaliarCompra(
    { total: R(5000), parcela: R(500), parcelas: 10, noCartao: true },
    base({ faturasEmDia: false }),
  );
  eq(atrasado.veredito, 'cuidado', 'fatura vencida derruba "pode" para "cuidado"');
  eq(atrasado.regras.faturasEmDia, false, 'a regra que falhou é nomeada');
  eq(atrasado.regras.todoMesPositivo, true, 'e não é por falta de folga');

  // `null` = não apurado. Não apurado não vira acusação.
  const naoApurado = avaliarCompra(
    { total: R(5000), parcela: R(500), parcelas: 10, noCartao: true },
    base({ faturasEmDia: null }),
  );
  eq(naoApurado.veredito, 'pode', 'faturasEmDia null não penaliza');
}
console.log('  ok');

// ── 6. Marcadores só quando medidos ────────────────────────────────────────
console.log('── 6. marcadores medidos ──');
{
  const r = avaliarCompra({ total: R(3000), parcela: R(300), parcelas: 10 }, {
    renda: calcularRenda([], [R(26121), R(12542), R(11630)]),   // oscila 55%
    saida: calcularSaida(R(3000), R(3000)),
    caixa: R(10000),
    cartao: null,                 // sem cartão informado
    faturasEmDia: null,           // não apurado
  });
  const chaves = r.motivos.map((m) => m.chave);
  ok(!chaves.includes('faturas'), 'faturasEmDia null → NÃO imprime "faturas em dia"');
  ok(!chaves.includes('limite'), 'sem cartão → NÃO imprime marcador de limite');
  const renda = r.motivos.find((m) => m.chave === 'renda');
  ok(renda && renda.bom === false, 'renda instável NÃO é marcada como boa');
  ok(renda && renda.variacao > 0.20, 'a variação medida acompanha o marcador');
}
console.log('  ok');

// ── 7. O caso real do dono (conferido no banco) ────────────────────────────
console.log('── 7. caso real ──');
{
  // schineiderlenon@gmail.com, medido: caixa R$3.142,07 · receitas fixas R$528
  // · despesas fixas R$492,59 · dívida celular 5×R$300 (1 paga) · Itaú limite
  // R$300, fatura R$146,89. Folga ≈ R$35/mês.
  const foto = {
    renda: calcularRenda([{ valor: R(328) }, { valor: R(200) }], []),
    saida: calcularSaida(R(492.59) + R(300), 0),   // fixas + parcela da dívida
    caixa: R(3142.07),
    cartao: { nome: 'Itaú Crédito', limite: R(300), faturaAberta: R(146.89), parcelasFuturas: 0 },
    faturasEmDia: true,
  };
  eq(foto.renda.valor, R(528), 'renda fixa do dono');

  const r = avaliarCompra({ total: R(5000), parcela: R(500), parcelas: 10, noCartao: true }, foto);
  eq(r.veredito, 'nao', 'ESTE É O TESTE QUE SEGURA A FEATURE: 10x500 tem de dar NÃO');
  ok(r.numeros.folga < 0, 'a folga dele já é negativa antes da compra');
}
console.log('  ok');

// ── Resultado ──────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.log(`❌ ${falhas.length} falha(s):`);
  for (const f of falhas) console.log('   · ' + f);
  process.exit(1);
}
console.log('✅ saudeCompra: tudo passou');
