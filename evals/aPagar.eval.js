// =============================================================================
// "O que eu tenho pra pagar essa semana?" + bloco de dívidas do RESUMO.
//
// Trava as regras de services/aPagarPeriodo.js e services/resumoDividas.js:
//   §1 o detector pega as formas de perguntar e NUNCA um lançamento/pagamento;
//   §2 a janela de datas (começa hoje; semana termina domingo);
//   §3 o que já foi resolvido NÃO aparece (baixa, pulado, fatura quitada) e o
//      adiado aparece na data nova;
//   §4 nada entra duas vezes (conta fixa × pendente amarrado, pendente de
//      cartão/fatura), e a dívida respeita as parcelas que faltam;
//   §5 o texto: total, sem valor fora do total, aviso de atraso;
//   §6 o bloco de dívidas do resumo usa a MESMA conta do "minhas dívidas".
//
// Rodar: node evals/aPagar.eval.js
// =============================================================================
const { interpretarRapido } = require('../src/handlers/interpretador');
const A = require('../src/services/aPagarPeriodo');
const { blocoDividas, saldoDevedor } = require('../src/services/resumoDividas');

const falhas = [];
let total = 0;
const ok = (c, msg) => { total += 1; if (!c) falhas.push(msg); };

const HOJE = '2026-09-18';            // sexta-feira
const fmt = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

// ── §1 DETECTOR ──────────────────────────────────────────────────────────────
const SIM = {
  'O que eu tenho para pagar essa semana?': 'semana',
  'O que eu tenho pra pagar essa semana?': 'semana',
  'O que tenho pra pagar hoje?': 'hoje',
  'o que tenho pra pagar amanhã': 'amanha',
  'O que tenho pra pagar neste mês?': 'mes',
  'o que falta pagar esse mês': 'mes',
  'quanto falta pagar no mês?': 'mes',
  'quais contas vencem essa semana': 'semana',
  'o que vence hoje': 'hoje',
  'tenho algo pra pagar amanhã?': 'amanha',
  'tem boleto pra pagar hoje?': 'hoje',
  'o que tenho pra pagar semana que vem': 'proxima_semana',
  'o que tenho pra pagar mês que vem': 'proximo_mes',
  'o que tenho pra pagar depois de amanhã': 'depois_amanha',
  'oq tenho pra pagar hj': 'hoje',
  'o que eu tenho que pagar amanhã?': 'amanha',
  'Quais são as contas que tenho pra pagar essa semana?': 'semana',
  'o que tenho pra pagar?': 'dias',
  'contas a pagar': 'dias',
};
for (const [frase, tipo] of Object.entries(SIM)) {
  const r = interpretarRapido(frase);
  ok(r?.acao === 'a_pagar', `§1 "${frase}" deveria ser a_pagar, veio ${JSON.stringify(r)}`);
  ok(r?.periodo?.tipo === tipo, `§1 "${frase}" período ${tipo}, veio ${JSON.stringify(r?.periodo)}`);
}
const nD = interpretarRapido('o que tenho pra pagar nos próximos 15 dias');
ok(nD?.acao === 'a_pagar' && nD.periodo.tipo === 'dias' && nD.periodo.n === 15, '§1 "próximos 15 dias" → dias n=15');

// ⚠️ O que NÃO pode virar consulta: lançamento, pagamento e perguntas de
// outro assunto. Conferido contra a ação que já tinham antes.
const NAO = {
  'paguei a luz 120': null,
  'pagar fatura nubank': 'pagar_fatura',
  'pagar divida carro 300': 'pagar_divida',
  'quanto gastei essa semana': 'resumo',
  'resumo': 'resumo',
  'resumo da semana': 'resumo',
  'minhas dividas': 'listar_dividas',
  'gastei 50 no mercado': 'salvar',
};
for (const [frase, acao] of Object.entries(NAO)) {
  const r = interpretarRapido(frase);
  ok((r?.acao ?? null) === acao, `§1 "${frase}" deveria seguir como ${acao}, veio ${JSON.stringify(r)}`);
}
for (const frase of ['tenho que pagar o aluguel amanhã', 'qual dia vence a fatura do nubank?',
  'quando vence minha fatura', 'preciso pagar 200 pro joão', 'quanto tenho pra pagar de 500',
  'já paguei o que tinha pra pagar hoje', 'paguei o que tenho pra pagar hoje',
  'qual conta vence hoje no cartao?']) {
  ok(A.detectarAPagar(frase) === null, `§1 "${frase}" NÃO é a pergunta do a pagar`);
}

// ── §2 JANELA ────────────────────────────────────────────────────────────────
const j = (p) => A.janelaAPagar(p, HOJE);
ok(j({ tipo: 'hoje' }).de === HOJE && j({ tipo: 'hoje' }).ate === HOJE, '§2 hoje');
ok(j({ tipo: 'amanha' }).de === '2026-09-19', '§2 amanhã');
ok(j({ tipo: 'semana' }).de === HOJE && j({ tipo: 'semana' }).ate === '2026-09-20', '§2 semana = hoje até domingo');
ok(A.janelaAPagar({ tipo: 'semana' }, '2026-09-20').ate === '2026-09-20', '§2 semana num domingo = só domingo');
ok(j({ tipo: 'proxima_semana' }).de === '2026-09-21' && j({ tipo: 'proxima_semana' }).ate === '2026-09-27', '§2 semana que vem = seg a dom');
ok(j({ tipo: 'mes' }).ate === '2026-09-30', '§2 mês = até o último dia');
ok(j({ tipo: 'proximo_mes' }).de === '2026-10-01' && j({ tipo: 'proximo_mes' }).ate === '2026-10-31', '§2 mês que vem');
ok(j({ tipo: 'dias', n: 7 }).ate === '2026-09-25', '§2 próximos 7 dias');
ok(j('semana').ate === '2026-09-20', '§2 período em texto (a IA às vezes manda assim)');
ok(A.janelaAPagar({ tipo: 'mes' }, '2026-02-10').ate === '2026-02-28', '§2 fevereiro');

// ── §3/§4 MONTAR ─────────────────────────────────────────────────────────────
const semana = j({ tipo: 'semana' });           // 18 a 20/09
const mes = j({ tipo: 'mes' });                 // 18 a 30/09
const recs = [
  { id: 'r-luz', tipo: 'Gasto', descricao: 'Luz', valor: 150, dia_vencimento: 19 },
  { id: 'r-net', tipo: 'Gasto', descricao: 'Internet', valor: 100, dia_vencimento: 20 },
  { id: 'r-alu', tipo: 'Gasto', descricao: 'Aluguel', valor: 1200, dia_vencimento: 20 },
  { id: 'r-agua', tipo: 'Gasto', descricao: 'Água', valor: 80, dia_vencimento: 25 },
  { id: 'r-passado', tipo: 'Gasto', descricao: 'Condomínio', valor: 500, dia_vencimento: 5 },
  { id: 'r-sal', tipo: 'Recebimento', descricao: 'Salário', valor: 5000, dia_vencimento: 19 },
  { id: 'r-sem', tipo: 'Gasto', descricao: 'Feira', valor: 60, frequencia: 'semanal', dia_semana: 6 },
  { id: 'r-var', tipo: 'Gasto', descricao: 'Gás', valor: null, valor_variavel: true, dia_vencimento: 19 },
];
const base = {
  recorrencias: recs,
  vinculadas: [
    { recorrencia_id: 'r-alu', competencia: '2026-09' },   // aluguel já pago adiantado
    { recorrencia_id: 'r-sem', competencia: '2026-09' },   // semanal: não pode sumir
  ],
  ajustes: [
    { recorrencia_id: 'r-net', competencia: '2026-09', status: 'pulado' },
    { recorrencia_id: 'r-agua', competencia: '2026-09', status: 'movido', nova_data: '2026-09-19', novo_valor: 95 },
  ],
  pendentes: [
    { tipo: 'Gasto', pago: false, valor: 339.44, data: '2026-09-19T00:00:00+00:00', observacao: '[Previsto] Conta de Luz 2' },
    { tipo: 'Gasto', pago: false, valor: 400, data: '2026-09-19', categoria: '💳 Fatura', observacao: 'Pagamento fatura' },
    { tipo: 'Gasto', pago: false, valor: 70, data: '2026-09-19', transferencia: true, observacao: 'Pix pra poupança' },
    { tipo: 'Gasto', pago: true, valor: 30, data: '2026-09-19', observacao: 'já pago' },
    { tipo: 'Gasto', pago: false, valor: 12, data: '2026-10-05', observacao: 'fora da janela' },
  ],
  dividas: [
    { id: 'd1', titulo: 'Empréstimo', valor_parcela: 208.01, parcelas_total: 24, parcelas_pagas: 10, dia_vencimento: 20, status: 'ativa' },
    { id: 'd2', titulo: 'Beliche', valor_parcela: 99, parcelas_total: 7, parcelas_pagas: 6, dia_vencimento: 20, status: 'ativa' },
    { id: 'd3', titulo: 'Quitada', valor_parcela: 50, parcelas_total: 5, parcelas_pagas: 5, dia_vencimento: 19, status: 'ativa' },
    { id: 'd4', titulo: 'Paga adiantado', valor_parcela: 40, parcelas_total: 10, parcelas_pagas: 3, dia_vencimento: 20, status: 'ativa', ultimo_pagamento: '2026-09-17' },
  ],
  faturas: [
    { nome: 'Nubank', venc: '2026-09-20', restante: 850.32 },
    { nome: 'Itaú', venc: '2026-09-19', restante: 0 },
    { nome: 'Inter', venc: '2026-10-10', restante: 300 },
  ],
};

const itS = A.montarItens(base, semana, HOJE);
const tem = (lista, desc, data) => lista.some((i) => i.descricao === desc && (!data || i.data === data));
ok(tem(itS, 'Luz', '2026-09-19'), '§3 conta fixa sem baixa aparece');
ok(!tem(itS, 'Aluguel'), '§3 conta fixa com BAIXA no mês não aparece');
ok(!tem(itS, 'Internet'), '§3 conta fixa PULADA não aparece');
ok(tem(itS, 'Água', '2026-09-19'), '§3 conta ADIADA aparece na data nova');
ok(itS.find((i) => i.descricao === 'Água')?.valor === 95, '§3 adiada com o valor novo');
ok(!tem(itS, 'Condomínio'), '§3 o que venceu antes de hoje não entra');
ok(!tem(itS, 'Salário'), '§3 receita não é "pra pagar"');
ok(tem(itS, 'Feira', '2026-09-19'), '§4 semanal NÃO some por baixa de outra semana');
ok(itS.find((i) => i.descricao === 'Gás')?.valor === null, '§3 variável sem estimativa entra sem valor');
ok(tem(itS, 'Conta de Luz 2', '2026-09-19'), '§4 pendente entra, sem o prefixo [Previsto]');
ok(!itS.some((i) => i.valor === 400), '§4 pagamento de fatura pendente não duplica a fatura');
ok(!tem(itS, 'Pix pra poupança'), '§4 transferência não é conta');
ok(!tem(itS, 'já pago'), '§4 transação paga não entra');
ok(tem(itS, 'Fatura Nubank', '2026-09-20'), '§3 fatura com saldo entra');
ok(!tem(itS, 'Fatura Itaú'), '§3 fatura quitada não entra');
ok(!tem(itS, 'Fatura Inter'), '§3 fatura fora da janela não entra');
ok(itS.find((i) => i.descricao === 'Empréstimo')?.detalhe === 'parcela 11/24', '§4 nº da parcela = pagas + 1');
ok(tem(itS, 'Beliche', '2026-09-20'), '§4 última parcela entra');
ok(!tem(itS, 'Quitada'), '§4 dívida sem parcela restante não entra');
ok(!tem(itS, 'Paga adiantado'), '§3 parcela paga adiantada não entra (proximoVencimento)');
ok(itS.every((a, i) => i === 0 || itS[i - 1].data <= a.data), '§4 ordenado por data');

// Janela maior: a dívida não passa das parcelas que faltam.
const doisMeses = A.janelaAPagar({ tipo: 'dias', n: 60 }, HOJE);
const beliches = A.montarItens(base, doisMeses, HOJE).filter((i) => i.descricao === 'Beliche');
ok(beliches.length === 1, `§4 Beliche (falta 1 parcela) aparece 1 vez em 60 dias, veio ${beliches.length}`);
const emprestimos = A.montarItens(base, doisMeses, HOJE).filter((i) => i.descricao === 'Empréstimo');
ok(emprestimos.length === 2 && emprestimos[1].data === '2026-10-20' && emprestimos[1].detalhe === 'parcela 12/24',
  '§4 em 60 dias o empréstimo aparece 2 vezes, parcelas 11 e 12');
ok(A.montarItens(base, mes, HOJE).some((i) => i.descricao === 'Água'), '§3 adiada também aparece no mês');

// ── §5 TEXTO ─────────────────────────────────────────────────────────────────
const txt = A.formatarAPagar(itS, semana, { fmt, hoje: HOJE });
const soma = itS.filter((i) => i.valor != null).reduce((s, i) => s + i.valor, 0);
ok(txt.includes(`Total: ${fmt(Math.round(soma * 100) / 100)}`), '§5 total = soma dos que têm valor');
ok(txt.includes('sem valor definido — fora do total'), '§5 avisa o que ficou sem valor');
ok(txt.includes('*Amanhã · 19/09*'), '§5 rótulo "Amanhã"');
ok(txt.includes('*Dom · 20/09*'), '§5 rótulo com dia da semana');
ok(!txt.includes('atrasada'), '§5 sem atraso, sem aviso');
const comAtraso = A.formatarAPagar([], semana, { fmt, hoje: HOJE, atrasadas: 2 });
ok(comAtraso.includes('Nada pra pagar') && comAtraso.includes('2 dívidas estão com parcela atrasada'),
  '§5 lista vazia ainda avisa dívida atrasada');
ok(A.contarAtrasadas([
  { status: 'em_atraso', dia_vencimento: 10 },
  { status: 'ativa', dia_vencimento: 10, ultimo_pagamento: '2026-07-10' },
  { status: 'ativa', dia_vencimento: 10, ultimo_pagamento: '2026-09-10' },
  { status: 'ativa', dia_vencimento: 10 },                       // sem pagamento = sem prova de atraso
], HOJE) === 2, '§5 contarAtrasadas usa a regra do painel');

// Datas das transações: meia-noite UTC = data pura; instante real → SP.
ok(A.diaDaTransacao('2026-09-19T00:00:00+00:00') === '2026-09-19', '§4 data pura');
ok(A.diaDaTransacao('2026-09-19T01:30:00+00:00') === '2026-09-18', '§4 instante real vira o dia de SP');

// ── §6 BLOCO DE DÍVIDAS DO RESUMO ────────────────────────────────────────────
ok(blocoDividas([], fmt, HOJE) === '', '§6 sem dívida = sem bloco (nada de cabeçalho solto)');
// Mesma conta do "minhas dívidas": restantes × parcela, senão valor_total.
ok(saldoDevedor({ parcelas_total: 24, parcelas_pagas: 10, valor_parcela: 208.01 }) === 2912.14, '§6 saldo por parcelas');
ok(saldoDevedor({ parcelas_total: 0, valor_total: 5000 }) === 5000, '§6 sem parcelas = valor_total');
const muitas = Array.from({ length: 8 }, (_, i) => ({
  id: `x${i}`, titulo: `Dívida ${i}`, valor_parcela: 100, parcelas_total: 10, parcelas_pagas: 5,
  dia_vencimento: 20 + (i % 5), status: i === 7 ? 'em_atraso' : 'ativa',
}));
const bloco = blocoDividas(muitas, fmt, HOJE);
ok(bloco.startsWith('*📋 Dívidas em aberto (8):*'), '§6 cabeçalho com a quantidade');
ok(bloco.includes('+2 outras'), '§6 mostra 6 e resume o resto');
ok(bloco.indexOf('Dívida 7') < bloco.indexOf('Dívida 0'), '§6 atrasada vem primeiro');
ok(bloco.includes(`Total devido: ${fmt(4000)}`), '§6 total soma TODAS, inclusive as não listadas');
ok(bloco.includes(`Parcelas somam ${fmt(800)} por mês`), '§6 soma das parcelas');
ok(!blocoDividas([{ titulo: 'Quitada', status: 'quitada', valor_total: 10 }], fmt, HOJE), '§6 quitada não entra');

// ── resultado ────────────────────────────────────────────────────────────────
if (falhas.length) {
  console.error(`❌ a pagar: ${falhas.length} de ${total} falharam`);
  for (const f of falhas) console.error('  -', f);
  process.exit(1);
}
console.log(`✅ a pagar + dívidas no resumo: ${total} verificações`);
