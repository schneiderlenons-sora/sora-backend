// =============================================================================
// EVAL — o retrato dos widgets (services/widgetResumo.js, `montarResumo`).
//
// Cenário montado à mão, com o resultado calculado à mão (não pela própria
// função). "Hoje" = quarta, 18/11/2026, meio-dia em São Paulo.
//
// Trava:
//   1. "vai sobrar": conta da empresa e cartão fora do saldo; fatura do mês
//      seguinte entra; fatura sem câmbio fica fora; pendente em cartão fora;
//      conta fixa já resolvida fora; parcela da dívida atrasada NÃO entra de
//      novo no mês (o próximo vencimento é dezembro);
//   2. Livre: por dia, maré, ritmo, os 3 estados e o limite do mês (o menor);
//   3. Próximas contas: atrasadas primeiro (só com prova — conta fixa nunca),
//      a janela de 7 dias, a régua, "Amanhã"/"Sexta, 20", "+3";
//   4. Cartões: "Fecha em N dias", "Fechada", pulo pra seguinte, atraso, moeda;
//   5. câmbio da fatura e ícones.
//
// Rodar: npm run eval:widget-resumo
// =============================================================================
const { montarResumo, faturaNaBase, quando, atrasoTexto, iconeDaConta } = require('../src/services/widgetResumo');

let falhas = 0; let ok = 0;
const eq = (a, b, msg) => {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja === jb) ok++; else { falhas++; console.log(`  ✗ ${msg}\n    esperado ${jb}\n    veio     ${ja}`); }
};
const AGORA = new Date('2026-11-18T15:00:00Z');

const base = () => ({
  base: 'BRL',
  wallets: [
    { nome: 'Nubank', tipo: 'Corrente', saldo_base: 2000 },
    { nome: 'Conta PJ', tipo: 'Corrente', saldo_base: 5000, da_empresa: { empresa_id: 'e1' } },
    { nome: 'Cartão X', tipo: 'Crédito', saldo_base: -500 },
  ],
  recorrencias: [
    { id: 'luz', tipo: 'Gasto', valor: 180, dia_vencimento: 25, descricao: 'Conta de luz' },
    { id: 'net', tipo: 'Gasto', valor: 120, dia_vencimento: 19, descricao: 'Internet Vivo' },
    { id: 'alug', tipo: 'Gasto', valor: 1500, dia_vencimento: 10, descricao: 'Aluguel' },
    { id: 'sal', tipo: 'Recebimento', valor: 3000, dia_vencimento: 30, descricao: 'Salário' },
    { id: 'res', tipo: 'Gasto', valor: 999, dia_vencimento: 20, descricao: 'Academia', resolvida_no_mes: true },
  ],
  vinculadas: [{ recorrencia_id: 'res', competencia: '2026-11' }],
  ajustes: [],
  dividas: [
    { id: 'carro', titulo: 'Carro', valor_parcela: 700, dia_vencimento: 20, status: 'ativa', ultimo_pagamento: '2026-10-20', data_inicio: '2026-01-15', parcelas_total: 48, parcelas_pagas: 10 },
    { id: 'emp', titulo: 'Empréstimo', valor_parcela: 250, dia_vencimento: 5, status: 'ativa', ultimo_pagamento: '2026-09-05', data_inicio: '2026-01-02', parcelas_total: 12, parcelas_pagas: 8 },
  ],
  faturas: [
    { cartao_id: 'c1', nome: 'Nubank', moeda: 'BRL', restante: 900, venc: '2026-11-21', ultimo: '2026-11-14', fim: '2026-11-14', fechada: true, quitada: false, atrasadas: [] },
    { cartao_id: 'c2', nome: 'Inter', moeda: 'BRL', restante: 300, venc: '2026-12-08', ultimo: '2026-12-01', fim: '2026-12-01', fechada: false, quitada: false, atrasadas: [{ venc: '2026-11-08', restante: 120 }] },
    { cartao_id: 'c3', nome: 'Amex', moeda: 'USD', taxa_base: null, restante: 100, venc: '2026-11-25', ultimo: '2026-11-15', fim: '2026-11-15', fechada: true, quitada: false, atrasadas: [] },
  ],
  pendentesTx: [
    { tipo: 'Gasto', valor: 50, pago: false, carteira_nome: 'Nubank', data: '2026-11-10T00:00:00+00:00', observacao: 'Conserto' },
    { tipo: 'Gasto', valor: 80, pago: false, carteira_nome: 'Cartão X', data: '2026-11-20T00:00:00+00:00', observacao: 'No cartão' },
    { tipo: 'Recebimento', valor: 200, pago: false, carteira_nome: 'Nubank', data: '2026-11-28T00:00:00+00:00' },
    { tipo: 'Gasto', valor: 400, pago: false, carteira_nome: 'Nubank', data: '2026-12-02T00:00:00+00:00', observacao: 'Dezembro' },
  ],
  gastosMes: 1000,
  metaMensal: null,
});

console.log('── 1–2. vai sobrar e Livre ──');
{
  const r = montarResumo(base(), { agora: AGORA });
  // saldo 2000 (só a pessoal) + a receber (salário 3000 + pendente 200)
  // − a pagar (luz 180 + internet 120 + carro 700 + fatura Nubank 900 + fatura
  //   Inter 300 (vence em dezembro, entra) + conserto 50) = 5200 − 2250 = 2950.
  // Fora: empresa, cartão, aluguel (já venceu), academia (resolvida), Amex (sem
  // câmbio), pendente no cartão, pendente de dezembro, empréstimo atrasado.
  eq(r.livre.projetado, 2950, '⚠️ vai sobrar = 2950');
  eq(r.livre.dias_restantes, 13, '13 dias até o fim do mês (18 a 30)');
  eq(r.livre.numero, '226', 'por dia: 2950 ÷ 13 = 226,92 → "226" (arredonda pra baixo)');
  eq(r.livre.prefixo, 'R$', 'prefixo');
  eq(r.livre.resto, 'R$ 2.950 até 30/11', 'resto');
  eq(r.livre.resto_oculto, 'R$ •••• até 30/11', 'resto com valores ocultos');
  eq(r.livre.estado, 'folgado', 'maré 2950/(2950+1000)=0,75 acima do ritmo 13/30=0,43');
  eq(r.livre.status, 'No ritmo', 'status');

  const lim = montarResumo({ ...base(), metaMensal: 2000 }, { agora: AGORA });
  eq([lim.livre.disponivel, lim.livre.numero], [1000, '76'], 'com limite: vale o MENOR (2000 − 1000 gastos = 1000 → 76 por dia)');
  eq([lim.livre.motivo, lim.livre.resto, lim.livre.resto_oculto], ['limite', 'R$ 1.000 até o limite', 'R$ •••• até o limite'],
    '⚠️ quando o LIMITE manda, o texto diz que é o limite (não "até 30/11")');
  eq(r.livre.motivo, 'caixa', 'sem limite, quem manda é o caixa');
  const limFolgado = montarResumo({ ...base(), metaMensal: 9000 }, { agora: AGORA });
  eq([limFolgado.livre.motivo, limFolgado.livre.resto], ['caixa', 'R$ 2.950 até 30/11'], 'limite folgado: o caixa é o menor e o texto é o do caixa');

  const apert = montarResumo({ ...base(), gastosMes: 10000 }, { agora: AGORA });
  eq([apert.livre.estado, apert.livre.status], ['apertado', 'Abaixo do ritmo'], 'muito gasto no mês → abaixo do ritmo');

  const verm = montarResumo({ ...base(), wallets: [{ nome: 'Nubank', tipo: 'Corrente', saldo_base: -1000 }, { nome: 'Cartão X', tipo: 'Crédito', saldo_base: -500 }] }, { agora: AGORA });
  eq([verm.livre.estado, verm.livre.motivo, verm.livre.prefixo, verm.livre.numero, verm.livre.abaixo, verm.livre.status, verm.livre.resto],
    ['vermelho', 'caixa', 'R$', '50', 'vai faltar no mês', 'Revise os gastos', 'Faltam 13 dias no mês'],
    'no vermelho pelo CAIXA: R$ 50 que vão faltar no mês (sem sinal: a frase explica)');

  // Caso real do dono (nov/2026): caixa sobrando, limite estourado. Antes saía
  // "−R$ 1.972 além do previsto" e não dava pra saber de onde vinha.
  const estourou = montarResumo({ ...base(), metaMensal: 4500, gastosMes: 6471.14 }, { agora: AGORA });
  eq([estourou.livre.estado, estourou.livre.motivo, estourou.livre.prefixo, estourou.livre.numero,
    estourou.livre.abaixo, estourou.livre.status, estourou.livre.resto, estourou.livre.resto_oculto],
  ['vermelho', 'limite', 'R$', '1.972', 'acima do limite', 'Limite estourado', 'R$ 6.471 de R$ 4.500', 'Faltam 13 dias no mês'],
  '⚠️ limite estourado com caixa positivo: diz que é o LIMITE e mostra gasto × limite');
  eq(estourou.livre.projetado, 2950, 'o "vai sobrar" do caixa continua no retrato (a aba Previstos não muda)');
}

console.log('── 3. Próximas contas ──');
{
  const c = montarResumo(base(), { agora: AGORA }).contas;
  eq(c.itens.map((i) => i.atrasada), [true, true, true], 'as 3 primeiras são as atrasadas');
  eq(c.itens.map((i) => i.titulo).sort(), ['Conserto', 'Empréstimo', 'Fatura Inter'], 'atrasadas: fatura vencida, parcela vencida e pendente que passou');
  eq(c.itens.find((i) => i.titulo === 'Fatura Inter').sub, 'Atrasada há 10 dias', 'texto da fatura atrasada');
  eq(c.itens.find((i) => i.titulo === 'Conserto').sub, 'Atrasada há 8 dias', 'texto do pendente atrasado');
  eq(c.itens.some((i) => /Aluguel|Academia/.test(i.titulo)), false, '⚠️ conta fixa NUNCA aparece como atrasada');
  eq(c.quantidade, 6, '3 atrasadas + internet, carro, fatura Nubank (luz dia 25 fica fora dos 7 dias)');
  eq(c.mais, 3, '"+3" além das 3 mostradas');
  eq(c.atrasadas, 3, 'contador de atrasadas');
  eq(c.dias.map((d) => d.letra).join(''), 'QQSSDST', 'régua: quarta a terça');
  eq(c.dias.map((d) => d.origem), [null, 'fixa', 'divida', 'fatura', null, null, null], 'pontos da régua: internet 19, carro 20, fatura 21');
  eq(c.dias[0].hoje, true, 'hoje marcado');
}

console.log('── 4. Cartões ──');
{
  const k = montarResumo(base(), { agora: AGORA }).cartoes;
  eq(k.map((x) => x.sub), ['Fechada · vence 21/11', 'Fecha em 13 dias · vence 08/12', 'Fechada · vence 25/11'], 'texto de cada cartão');
  eq(k[1].atraso_txt, 'R$ 120,00 em atraso', 'atraso do Inter');
  eq(k[2].valor_txt, 'US$ 100,00', 'cartão em dólar mostra a moeda DELE');
  const pulo = montarResumo({ ...base(), faturas: [{ cartao_id: 'c9', nome: 'C6', moeda: 'BRL', restante: 0, quitada: true, fechada: true, venc: '2026-11-15', ultimo: '2026-11-05', proxima: { restante: 432.1, venc: '2026-12-15' }, atrasadas: [] }] }, { agora: AGORA }).cartoes[0];
  eq([pulo.valor, pulo.sub], [432.1, 'Vence 15/12'], 'fechou e foi paga → mostra a seguinte (mesma regra da tela de cartões)');
}

console.log('── 5. câmbio, textos e ícones ──');
{
  const f = faturaNaBase({ moeda: 'USD', taxa_base: 5, restante: 100, fatura: 120, atrasadas: [{ restante: 10 }] }, 'BRL');
  eq([f.restante, f.fatura, f.atrasadas[0].restante, f.moeda], [500, 600, 50, 'BRL'], 'fatura em dólar convertida pela taxa');
  eq(faturaNaBase({ moeda: 'USD', taxa_base: null, restante: 1 }, 'BRL'), null, 'sem câmbio: fica fora (nunca soma dólar como real)');
  eq([quando('2026-11-18', '2026-11-18'), quando('2026-11-19', '2026-11-18'), quando('2026-11-20', '2026-11-18'), quando('2026-11-22', '2026-11-18')],
    ['Hoje', 'Amanhã', 'Sexta, 20', 'Domingo, 22'], 'datas por extenso');
  eq(atrasoTexto('2026-11-17', '2026-11-18'), 'Atrasada desde ontem', 'atraso de 1 dia');
  eq(['Conta de luz', 'Internet Vivo', 'Aluguel', 'Academia', 'x'].map((t) => iconeDaConta(t, 'fixa')).concat(iconeDaConta('Fatura', 'fatura')),
    ['luz', 'internet', 'casa', 'fixa', 'fixa', 'cartao'], 'ícones');
}

console.log(`\n${ok} verificações · ${falhas ? `${falhas} FALHAS` : 'todas ok'}`);
if (falhas) process.exit(1);
