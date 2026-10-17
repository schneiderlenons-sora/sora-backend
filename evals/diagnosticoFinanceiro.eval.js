// =============================================================================
// EVAL do DIAGNÓSTICO FINANCEIRO (services/diagnosticoFinanceiro.js).
//
// A varredura só vale se o que ela acusa for verdade E se ela não deixar passar
// o que importa. Os dois erros já aconteceram na 1ª versão, medidos na base:
//   · "fatura paga em aberto" comparava o pago com o RESTANTE — fatura de 200
//     com 100 pagos (restante 100) era acusada de paga. 10 falsos "erros";
//   · a regra ingênua de transferência entre contas casava Pix de R$ 10 pra
//     pessoas diferentes (por isso ela é 'sinal', R$ 50+ e par sem disputa).
//
// Rodar:  npm run eval:diagnostico
// =============================================================================
const D = require('../src/services/diagnosticoFinanceiro');
const { ehDuplicata } = require('../src/services/duplicadas');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

const G = 'g1', H = 'g2';
// ehTransferencia mínima pros testes: a real lê categoria/flag igual.
const ehTransf = (t) => t.transferencia === true || t.categoria === 'Transferências';

console.log('── 1. previsto × cobrança igual do banco ──');
{
  const prova = (p, c) => ehDuplicata(p, c) === 'manual-e-banco';
  const prev = { id: 'p', grupo_id: G, valor: 2911.6, tipo: 'Gasto', carteira_nome: 'BTG', data: '2026-10-15T00:00:00+00:00', observacao: 'Fatura BTG', pago: false, of_tx_id: null };
  const cob = { id: 'b', grupo_id: G, valor: 2911.6, tipo: 'Gasto', carteira_nome: 'BTG', data: '2026-10-15T13:16:59Z', observacao: 'CardBankslip', pago: true, of_tx_id: 'x' };
  eq(D.previstosConciliaveis([prev, cob], prova).length, 1, '§1 o par do Vander é achado');
  // ⚠️ grupos diferentes NUNCA se casam (mesmo valor, conta e dia)
  eq(D.previstosConciliaveis([prev, { ...cob, grupo_id: H }], prova).length, 0, '§1 não cruza grupos');
  eq(D.previstosConciliaveis([prev], prova).length, 0, '§1 sem cobrança, nada');
}
console.log('  ok');

console.log('── 2. duplicata confirmada ──');
{
  const base = { grupo_id: G, valor: 100, tipo: 'Gasto', carteira_nome: 'Nubank', observacao: 'PIX ENVIADO', data: '2026-10-01T10:00:00.123Z', categoria: 'Pix', pago: true };
  const r = D.duplicatasConfirmadas([{ ...base, id: 'a', created_at: '1' }, { ...base, id: 'b', created_at: '2' }]);
  eq(r.length, 1, '§2 mesmo instante = 1 duplicata');
  eq(r[0].valor, 100, '§2 valor = o que sobra contado a mais (1 cópia)');
  const tres = D.duplicatasConfirmadas(['a', 'b', 'c'].map((id, i) => ({ ...base, id, created_at: String(i) })));
  eq(tres[0].valor, 200, '§2 três cópias = 2 a mais');
  eq(D.duplicatasConfirmadas([{ ...base, id: 'a' }, { ...base, id: 'b', grupo_id: H }]).length, 0, '§2 não cruza grupos');
}
console.log('  ok');

console.log('── 3. transferência entre contas próprias (sinal) ──');
{
  const W = [
    { grupo_id: G, nome: 'Inter PJ', tipo: 'Corrente' }, { grupo_id: G, nome: 'BTG', tipo: 'Corrente' },
    { grupo_id: G, nome: 'Inter Crédito', tipo: 'Crédito' },
  ];
  const s = { id: 's', grupo_id: G, tipo: 'Gasto', valor: 11900, carteira_nome: 'Inter PJ', data: '2026-10-16', categoria: '💰 Financeiro', observacao: 'Transferência para BTG' };
  const e = { id: 'e', grupo_id: G, tipo: 'Recebimento', valor: 11900, carteira_nome: 'BTG', data: '2026-10-16T17:57:00Z', categoria: 'Transferência recebida', observacao: 'Pix VCS' };
  eq(D.transferenciasEntreContas([s, e], W, ehTransf).length, 1, '§3 o caso do Vander é achado');
  eq(D.transferenciasEntreContas([s, { ...e, carteira_nome: 'Inter PJ' }], W, ehTransf).length, 0, '§3 mesma conta não é transferência');
  eq(D.transferenciasEntreContas([s, { ...e, carteira_nome: 'Inter Crédito' }], W, ehTransf).length, 0, '§3 cartão fica de fora');
  eq(D.transferenciasEntreContas([{ ...s, valor: 10 }, { ...e, valor: 10 }], W, ehTransf).length, 0, '§3 abaixo de R$ 50 não acusa (falso positivo medido)');
  eq(D.transferenciasEntreContas([s, { ...e, data: '2026-10-19' }], W, ehTransf).length, 0, '§3 3 dias depois não casa');
  eq(D.transferenciasEntreContas([{ ...s, categoria: 'Transferências' }, e], W, ehTransf).length, 0, '§3 já marcada como transferência: fora');
  // ⚠️ disputa nos dois lados: não afirma
  eq(D.transferenciasEntreContas([s, e, { ...e, id: 'e2' }], W, ehTransf).length, 0, '§3 duas entradas iguais: não afirma');
  eq(D.transferenciasEntreContas([s, { ...s, id: 's2' }, e], W, ehTransf).length, 0, '§3 duas saídas iguais: não afirma');
  eq(D.transferenciasEntreContas([s, { ...e, grupo_id: H }], [...W, { grupo_id: H, nome: 'BTG', tipo: 'Corrente' }], ehTransf).length, 0, '§3 não cruza grupos');
}
console.log('  ok');

console.log('── 4. previsto vencido ──');
{
  const hoje = '2026-10-16';
  const p = { grupo_id: G, pago: false, of_tx_id: null, valor: 750, data: '2026-09-20', tipo: 'Gasto', observacao: 'Condomínio', carteira_nome: 'Santander' };
  eq(D.previstosVencidos([p], hoje).length, 1, '§4 26 dias atrás: acusa');
  eq(D.previstosVencidos([{ ...p, data: '2026-10-10' }], hoje).length, 0, '§4 6 dias: dentro da tolerância');
  eq(D.previstosVencidos([{ ...p, pago: true }], hoje).length, 0, '§4 pago: fora');
  eq(D.previstosVencidos([{ ...p, of_tx_id: 'x' }], hoje).length, 0, '§4 do banco: fora');
  eq(D.previstosVencidos([{ ...p, parcela_total: 10 }], hoje).length, 0, '§4 parcela: fora (tem cronograma próprio)');
}
console.log('  ok');

console.log('── 5. conta-fantasma ──');
{
  const W = [{ grupo_id: G, nome: 'Nubank', tipo: 'Corrente' }];
  const t = (n, v = 10) => ({ grupo_id: G, carteira_nome: n, valor: v });
  eq(D.transacoesOrfas([t('Nubank'), t('nubank '), t('NUBANK')], W).length, 0, '§5 nome casa sem caixa/espaço');
  const r = D.transacoesOrfas([t('Dinheiro', 50), t('Dinheiro', 25)], W);
  eq(r.length, 1, '§5 agrupa por conta inexistente');
  eq(r[0].valor, 75, '§5 soma o valor');
  eq(D.transacoesOrfas([{ ...t('Nubank'), grupo_id: H }], W).length, 1, '§5 conta de OUTRO grupo não vale');
}
console.log('  ok');

console.log('── 6. conexão encerrada ──');
{
  const W = [
    { grupo_id: G, nome: 'Cartão', tipo: 'Crédito', of_conta_id: 'c1', of_consent_id: 'morto', saldo: -100 },
    { grupo_id: G, nome: 'Conta', tipo: 'Corrente', of_conta_id: 'c2', of_consent_id: 'vivo', saldo: 50 },
    { grupo_id: G, nome: 'Manual', tipo: 'Corrente', of_conta_id: null, of_consent_id: null, saldo: 10 },
    { grupo_id: G, nome: 'Legado', tipo: 'Corrente', of_conta_id: 'c3', of_consent_id: null, saldo: 10 },
  ];
  const r = D.contasConexaoEncerrada(W, [{ external_id: 'vivo' }]);
  eq(r.length, 1, '§6 só a conta presa ao consentimento morto');
  ok(/cartão "Cartão"/.test(r[0].detalhe), '§6 diz que é cartão');
}
console.log('  ok');

console.log('── 7. pagamento de fatura em dobro ──');
{
  const p = { grupo_id: G, cartao_id: 'k', competencia: '2026-10', valor: 5169.95, data: '2026-10-06' };
  const r = D.pagamentosFaturaDuplicados([p, { ...p }, { ...p, competencia: '2026-09' }]);
  eq(r.length, 1, '§7 o par repetido é achado');
  eq(r[0].valor, 5169.95, '§7 valor contado a mais');
  eq(D.pagamentosFaturaDuplicados([p, { ...p, data: '2026-10-07' }]).length, 0, '§7 dias diferentes: são dois pagamentos');
}
console.log('  ok');

console.log('── 8. fatura vencida em aberto ──');
{
  const hoje = '2026-10-16';
  const f = { grupo_id: G, cartao: 'Inter', competencia: '2026-10', venc: '2026-10-11', fatura: 3655.35, restante: 3655.35, fonte: 'banco', pagoRegistrado: 3655.35 };
  let r = D.faturasVencidasAbertas([f], hoje);
  eq(r.erros.length, 1, '§8 pago registrado cobre a fatura e ela segue aberta: ERRO');
  // ⚠️ A REGRA ERRADA DA 1ª VERSÃO: pago parcial igual ao restante NÃO é "paga".
  r = D.faturasVencidasAbertas([{ ...f, fatura: 200, restante: 100, pagoRegistrado: 100 }], hoje);
  eq(r.erros.length, 0, '§8 parcial (200, pago 100) NÃO é erro');
  eq(r.atencoes.length, 1, '§8 parcial vira atenção');
  r = D.faturasVencidasAbertas([{ ...f, pagoRegistrado: 0 }], hoje);
  eq(r.atencoes.length, 1, '§8 sem pagamento: atenção (pode ser atraso real)');
  r = D.faturasVencidasAbertas([{ ...f, venc: '2026-10-18' }], hoje);
  eq(r.erros.length + r.atencoes.length, 0, '§8 ainda não venceu: nada');
  r = D.faturasVencidasAbertas([{ ...f, venc: '2026-10-16' }], hoje);
  eq(r.erros.length + r.atencoes.length, 0, '§8 vence HOJE: ainda não venceu');
  r = D.faturasVencidasAbertas([{ ...f, restante: 0 }], hoje);
  eq(r.erros.length + r.atencoes.length, 0, '§8 quitada: nada');
}
console.log('  ok');

console.log('── 9. relatório e novidades ──');
{
  const verif = [
    { id: 'b', titulo: 'B', gravidade: 'sinal', explica: '', achados: [{ grupo_id: G, valor: 1, detalhe: 'x' }] },
    { id: 'a', titulo: 'A', gravidade: 'erro', explica: '', achados: [{ grupo_id: G, valor: 10.005, detalhe: 'y' }, { grupo_id: H, valor: 5, detalhe: 'z' }] },
    { id: 'c', titulo: 'C', gravidade: 'atencao', explica: '', achados: [] },
  ];
  const rel = D.montarRelatorio(verif, new Map([[G, 'g@x']]));
  eq(rel.checks[0].id, 'a', '§9 erro vem primeiro');
  eq(rel.checks[2].id, 'b', '§9 sinal por último');
  eq(rel.checks[0].contas, 2, '§9 conta grupos distintos');
  eq(rel.checks[0].valor, 15.01, '§9 soma em centavos');
  eq(rel.checks[0].amostra[0].email, 'g@x', '§9 e-mail do grupo');
  eq(rel.resumo.erros, 2, '§9 resumo de erros');
  eq(rel.resumo.sinais, 1, '§9 resumo de sinais');
  // novidades: só o que não estava no retrato anterior
  const anterior = D.montarRelatorio([{ ...verif[1], achados: [verif[1].achados[0]] }]);
  const nov = D.novidades(rel, anterior);
  eq(nov.length, 2, '§9 novidade = o que surgiu (z do erro + x do sinal)');
  ok(nov.some((n) => n.detalhe === 'z') && !nov.some((n) => n.detalhe === 'y'), '§9 o que já existia não é novidade');
  eq(D.novidades(rel, null).length, 0, '§9 sem retrato anterior: sem novidades');
}
console.log('  ok');

console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ diagnóstico financeiro: todos os casos passaram');
