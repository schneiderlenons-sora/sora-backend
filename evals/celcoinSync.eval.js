// =============================================================================
// EVAL do sync Celcoin (services/polpCelcoinSync) — normalização pura, sem banco.
//
// Os payloads abaixo são os EXEMPLOS LITERAIS da doc da Polp
// (https://polp.com.br/docs/celcoin, ver docs/CELCOIN-API.md). Se a Polp mudar o
// contrato, este eval quebra antes do dinheiro aparecer errado no painel.
//
// Rodar:   npm run eval:celcoin
// Sai com código != 0 se algo falhar.
// =============================================================================

const S = require('../src/services/polpCelcoinSync');

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); };
const quase = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) < tol;

// ── 1. money(): dinheiro é STRING em { amount, currency } ───────────────────
console.log('── 1. money() ──');
ok(S.money({ amount: '1500.00', currency: 'BRL' }) === 1500, 'money("1500.00") ≠ 1500');
ok(S.money('0.00') === 0, 'money("0.00") deveria ser 0');
ok(S.money(null) === null, 'money(null) tem de ser null (não-sincronizado ≠ zero)');
ok(S.money({ amount: null }) === null, 'amount null → null');
ok(S.money(42) === 42, 'número puro');
console.log('  ok');

// ── 2. pct(): a doc usa DOIS formatos pro mesmo conceito ────────────────────
// "post_fixed_indexer_percentage: 1.000000 = 100% do CDI" (descrição do campo)
// × "100 para 100% do CDI" (tabela de exemplos). Aceitamos os dois.
console.log('── 2. pct() — ambiguidade da doc ──');
ok(S.pct('1.000000') === 100, 'pct 1.000000 → 100');
ok(S.pct('100') === 100, 'pct 100 → 100');
ok(S.pct('1.020000') === 102, 'pct 1.02 → 102 (102% do CDI)');
ok(S.pct('0.150000') === 15, 'pct 0.15 → 15');
ok(S.pct('16.76') === 16.76, 'pct 16.76 → 16.76');
ok(S.pct(null) === null, 'pct null');
console.log('  ok');

// ── 3. cetParaMensal(): dividas.taxa_juros é % ao MÊS; CET é ANUAL ─────────
console.log('── 3. cetParaMensal() ──');
ok(quase(S.cetParaMensal('0.290000'), 2.1447), 'CET 29% a.a. → ~2,1447% a.m.');
ok(quase(S.cetParaMensal('29'), 2.1447), 'CET no formato "29" dá o mesmo');
ok(S.cetParaMensal(null) === null, 'sem CET → null');
ok(S.cetParaMensal('0') === null, 'CET 0 → null');
console.log(`  ok (29% a.a. = ${S.cetParaMensal('0.290000')}% a.m.)`);

// ── 4. limiteTotalDoCartao(): limits[] é ARRAY por modalidade ──────────────
console.log('── 4. limiteTotalDoCartao() ──');
const L = S.limiteTotalDoCartao([
  { credit_line_limit_type: 'LIMITE_CREDITO_MODALIDADE_OPERACAO', consolidation_type: 'INDIVIDUAL',
    limit_amount: { amount: '999.00' }, line_name: 'SAQUE_CREDITO_BRASIL' },
  { credit_line_limit_type: 'LIMITE_CREDITO_TOTAL', consolidation_type: 'CONSOLIDADO',
    limit_amount: { amount: '5000.00' }, used_amount: { amount: '1200.00' },
    available_amount: { amount: '3800.00' }, line_name: 'CREDITO_A_VISTA' },
]);
ok(L.limite === 5000 && L.usado === 1200 && L.disponivel === 3800,
  `limite total errado: ${JSON.stringify(L)} — não pode pegar a linha de SAQUE`);
ok(S.limiteTotalDoCartao([]).limite === null, 'limits vazio → null');
ok(S.limiteTotalDoCartao(null).limite === null, 'limits null → null');

// ⚠️ CASO REAL (Nubank, ago/2026): o cartão mandou UMA única linha de limite, e
// era o "Limite Nupay" — uma MODALIDADE, não o teto do cartão. O fallback
// antigo ("sem TOTAL, pega o maior") adotou os R$ 300,45 como limite do
// cartão, e o painel passou a mostrar "limite R$ 300,45 · 100% usado" num
// cartão cuja fatura do mês foi R$ 2.293,71.
// Preferir NULL a um teto falso: limite errado contamina a barra de uso e o
// alerta de limite estourado.
const soNupay = S.limiteTotalDoCartao([
  { credit_line_limit_type: 'LIMITE_CREDITO_MODALIDADE_OPERACAO', consolidation_type: 'INDIVIDUAL',
    identification_number: '0864', line_name: 'OUTROS', line_name_additional_info: 'Limite Nupay',
    limit_amount: { amount: '300.4500' }, used_amount: { amount: '300.45' },
    available_amount: { amount: '0.00' } },
]);
ok(soNupay.limite === null,
  `só MODALIDADE_OPERACAO (NuPay) NÃO pode virar limite do cartão — veio ${JSON.stringify(soNupay)}`);
ok(soNupay.usado === null, 'e nem o "usado" da modalidade vira o usado do cartão');
console.log('  ok');

// ── 5. Fatura em aberto = próximo vencimento ≥ hoje ────────────────────────
console.log('── 5. escolherFaturaAberta() ──');
const BILLS3 = [{ id: 'b1', due_date: '2026-06-10' }, { id: 'b2', due_date: '2026-08-10' }, { id: 'b3', due_date: '2026-07-10' }];
ok(S.escolherFaturaAberta(BILLS3, '2026-07-05').id === 'b3', 'antes do venc → b3');
ok(S.escolherFaturaAberta(BILLS3, '2026-07-10').id === 'b3', 'vence HOJE ainda é a aberta');
ok(S.escolherFaturaAberta(BILLS3, '2026-07-11').id === 'b2', 'venceu → próxima');
// ⚠️ ESTE CASO MUDOU DE EXPECTATIVA — o antigo ("todas passadas → mais
// recente") ERA o bug. O emissor só publica a fatura DEPOIS que ela fecha,
// então no meio do ciclo a lista termina na fatura passada; devolvê-la como
// "aberta" fazia o painel somar as compras dela + as do ciclo novo (numa conta
// real: R$ 5.013,99 no lugar de R$ 3.423,57). Sem fatura publicada à frente o
// certo é null, e o valor vem do limite usado (regra de ouro).
ok(S.escolherFaturaAberta(BILLS3, '2027-01-01') === null, 'todas passadas → null (nunca a fechada)');
ok(S.escolherFaturaAberta([], '2026-07-05') === null, 'sem bills → null');
ok(S.ultimaFaturaPublicada(BILLS3).id === 'b2', 'as DATAS ainda saem da última publicada');
ok(S.pagoDaFatura({ payments: [{ amount: '100.00' }, { amount: '46.89' }] }) === 146.89, 'soma payments[]');
console.log('  ok');

// ── 6. CONTA (exemplo literal de /consents/{id}/accounts) ──────────────────
console.log('── 6. normalizeConta() ──');
const CONTA = {
  id: '550e8400-e29b-41d4-a716-446655440001', brand_name: 'Itaú Unibanco',
  type: 'CONTA_DEPOSITO_A_VISTA',
  identification: { type: 'CONTA_DEPOSITO_A_VISTA', subtype: 'INDIVIDUAL', currency: 'BRL' },
  balance: {
    available_amount: { amount: '1500.00', currency: 'BRL' },
    blocked_amount: { amount: '0.00', currency: 'BRL' },
    automatically_invested_amount: { amount: '200.00', currency: 'BRL' },
  },
  overdraft_limit: {
    overdraft_contracted_limit: { amount: '500.00', currency: 'BRL' },
    overdraft_used_limit: { amount: '0.00', currency: 'BRL' },
  },
};
const c = S.normalizeConta(CONTA);
// ⚠️ ESTE CASO MUDOU DE EXPECTATIVA (ago/2026) — antes cravava
// `c.saldo === 1500` com a justificativa "não somar automatically_invested,
// é investimento". A suposição estava ERRADA e um cliente provou:
//     available_amount ............... R$     1,00
//     automatically_invested_amount .. R$ 2.541,17
//     app do Itaú mostrava ........... R$ 2.541,12
// O painel exibia R$ 1,00. Aplicação automática não é investimento de
// carteira: é saldo da conta que o banco rende sozinho e resgata quando o
// cliente gasta — o próprio app soma. Detalhes na seção 6C.
ok(c.saldo === 1700, 'saldo soma available (1500) + automatically_invested (200)');
ok(c.extras.saldo_aplicado === 200, 'a parcela aplicada fica guardada pra tela explicar');
ok(c.tipo === 'Corrente', 'CONTA_DEPOSITO_A_VISTA → Corrente');
ok(c.nome === 'Itaú Unibanco', 'nome = brand_name');
ok(c.extras.cheque_especial === 500, 'cheque especial contratado');
const c2 = S.normalizeConta({ id: 'x', brand_name: 'Nubank', type: 'CONTA_POUPANCA' });
ok(c2.saldo === null && c2.sincronizado === false, 'sem balance → saldo null (não 0)');
ok(c2.tipo === 'Poupança' && c2.nome === 'Nubank Poupança', 'poupança identificada no nome');
console.log('  ok');

// ── 7. CARTÃO + FATURA (o núcleo — datas que a Pluggy não dava) ────────────
console.log('── 7. normalizeCartao() ──');
const CARD = {
  id: '660e8400', brand_name: 'Itaú Unibanco', name: 'Cartão Universitário',
  credit_card_network: 'VISA', product_type: 'GOLD',
  identification: { name: 'Cartão Universitário', credit_card_network: 'VISA',
    payment_methods: [{ identification_number: '4453', is_multiple_credit_card: true }] },
  limits: [{ credit_line_limit_type: 'LIMITE_CREDITO_TOTAL', consolidation_type: 'INDIVIDUAL',
    limit_amount: { amount: '5000.00' }, used_amount: { amount: '1200.00' },
    available_amount: { amount: '3800.00' }, line_name: 'CREDITO_A_VISTA' }],
};
const BILLS = [
  { id: 'bA', due_date: '2026-08-10', bill_closing_date: '2026-08-03', is_instalment: false,
    bill_minimum_amount: { amount: '150.00' }, bill_total_amount: { amount: '1500.00' },
    payments: [{ amount: '500.00', paymentDate: '2026-08-05', paymentMode: 'PIX' }] },
  { id: 'bB', due_date: '2026-07-10', bill_closing_date: '2026-07-03',
    bill_total_amount: { amount: '900.00' }, payments: [{ amount: '900.00' }] },
];
const k = S.normalizeCartao(CARD, BILLS, '2026-08-06');
ok(k.tipo === 'Crédito', 'tipo Crédito');
ok(k.extras.limite === 5000, 'limite do LIMITE_CREDITO_TOTAL');
ok(k.extras.bandeira === 'Visa', 'VISA → Visa');
ok(k.extras.ultimos4 === '4453', 'últimos 4 de payment_methods');
ok(k.extras.dia_fechamento === 3, 'dia_fechamento vem de bill_closing_date (Pluggy mandava null)');
ok(k.extras.dia_vencimento === 10, 'dia_vencimento vem de due_date');
ok(k.extras.pagamento_minimo === 150, 'pagamento mínimo real do banco');
ok(k.faturaAberta && k.faturaAberta.billId === 'bA', 'fatura aberta = a que vence 10/08');
ok(k.faturaAberta.restante === 1000, 'restante = 1500 − 500 pago');
ok(k.saldoFatura === -1000, 'saldo negativo = fatura a pagar (o painel lê −saldo)');
const k2 = S.normalizeCartao(CARD, [], '2026-08-06');
ok(k2.saldoFatura === null, 'sem fatura publicada → saldo null (não zera o cartão)');
ok(k2.extras.limite === 5000, 'limite continua vindo sem bills');
console.log('  ok');

// ── 8. TRANSAÇÃO DE CONTA ─────────────────────────────────────────────────
console.log('── 8. normalizeTxConta() ──');
const g = S.normalizeTxConta({ id: 't1', transaction_name: 'MERCADO SAO JOSE',
  credit_debit_type: 'DEBITO', completed_authorised_payment_type: 'TRANSACAO_EFETIVADA',
  transaction_amount: { amount: '87.50' }, transaction_date_time: '2026-07-20T10:00:00Z',
  category_ref: 'FOOD_AND_DRINK_GROCERIES' });
ok(g.ehGasto === true && g.valor === 87.5, 'DEBITO → Gasto 87,50');
ok(g.categoria === 'Supermercado', `categoria via taxonomia (veio ${g && g.categoria})`);
ok(S.normalizeTxConta({ id: 't3', completed_authorised_payment_type: 'LANCAMENTO_FUTURO',
  transaction_amount: { amount: '99.00' }, credit_debit_type: 'DEBITO' }) === null,
  'LANCAMENTO_FUTURO NÃO pode ser importado');
const pg = S.normalizeTxConta({ id: 't4', transaction_name: 'PAGAMENTO FATURA',
  credit_debit_type: 'DEBITO', completed_authorised_payment_type: 'TRANSACAO_EFETIVADA',
  transaction_amount: { amount: '1000.00' }, transaction_date_time: '2026-07-10T10:00:00Z',
  category_ref: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' });
// Categoria "Fatura" = subcategoria de Financeiro (migration 103). Era a string
// solta 'Fatura cartão', que não existia na taxonomia.
ok(pg.transferencia === true && S.ehPagamentoFatura(pg.categoria), 'pagamento de fatura = transferência');
console.log('  ok');

// ── 9. TRANSAÇÃO DE CARTÃO ────────────────────────────────────────────────
console.log('── 9. normalizeTxCartao() ──');
const HOJE = '2026-07-25';
const intl = S.normalizeTxCartao({ id: 'c2', transaction_name: 'OPENAI',
  credit_debit_type: 'DEBITO', transaction_type: 'PAGAMENTO',
  brazilian_amount: { amount: '110.00', currency: 'BRL' },
  amount: { amount: '20.00', currency: 'USD' },
  transaction_date_time: '2026-07-21T10:00:00Z' }, HOJE);
ok(intl.valor === 110, 'compra internacional usa brazilian_amount (110), não amount (20 USD)');
const pf = S.normalizeTxCartao({ id: 'c3', transaction_name: 'PAGAMENTO RECEBIDO',
  credit_debit_type: 'CREDITO', transaction_type: 'PAGAMENTO_FATURA',
  brazilian_amount: { amount: '1000.00' }, transaction_date_time: '2026-07-15T10:00:00Z' }, HOJE);
ok(pf.transferencia === true && pf.ehGasto === false, 'PAGAMENTO_FATURA = transferência, não gasto');
ok(S.normalizeTxCartao({ id: 'c4', transaction_name: 'HOTEIS.COM 12/12',
  credit_debit_type: 'DEBITO', transaction_type: 'PAGAMENTO',
  brazilian_amount: { amount: '250.00' }, transaction_date_time: '2027-03-13T10:00:00Z',
  charge_identificator: 12, charge_number: 12 }, HOJE) === null,
  'parcela a vencer (data futura) NÃO pode virar gasto');
console.log('  ok');

// ── 10. EMPRÉSTIMO → dividas (exemplo literal de /consents/{id}/loans) ────
console.log('── 10. normalizeDivida() ──');
const LOAN = {
  id: '770e8400', brand_name: 'Itaú Unibanco', product_type: 'EMPRESTIMOS',
  product_sub_type: 'CREDITO_PESSOAL_COM_CONSIGNACAO',
  contract: { contract_number: '1324926521496', product_name: 'Crédito Pessoal Consignado',
    contract_date: '2018-01-05', contract_amount: '50000.0000', instalment_periodicity: 'MENSAL',
    cet: '0.290000', amortization_scheduled: 'PRICE', due_date: '2028-01-15',
    first_instalment_due_date: '2018-02-15', next_instalment_amount: '1250.0000',
    interest_rates: [{ referential_rate_indexer_type: 'PRE_FIXADO', pre_fixed_rate: '0.150000' }] },
  scheduled_instalments: { total_number_of_instalments: 48, contract_remaining_number: 36,
    paid_instalments: 12, due_instalments: 1, past_due_instalments: 0 },
  payments: { paid_instalments: 12, contract_outstanding_balance: '45000.00' },
};
const d = S.normalizeDivida(LOAN, 'emprestimo');
ok(d.tipo === 'consignado', 'CREDITO_PESSOAL_COM_CONSIGNACAO → consignado (CHECK da tabela)');
ok(d.valor_total === 50000 && d.valor_parcela === 1250, 'valor total e parcela');
ok(d.parcelas_total === 48 && d.parcelas_pagas === 12, '48 parcelas, 12 pagas');
ok(quase(d.taxa_juros, 2.1447), 'CET anual convertido pra % MENSAL (a Sora guarda mensal)');
ok(d.indexador === 'pre', 'PRE_FIXADO → pre');
ok(d.dia_vencimento === 15, 'dia do first_instalment_due_date');
ok(d.status === 'ativa', 'status ativa');
ok(/Saldo devedor: R\$ 45000/.test(d.observacao), 'saldo devedor real na observação');
ok(S.normalizeDivida({ id: 'x', contract: {} }, 'emprestimo') === null,
  'sem contract_amount → null (a tabela exige valor_total > 0)');
ok(S.normalizeDivida({ ...LOAN, scheduled_instalments: { ...LOAN.scheduled_instalments, past_due_instalments: 2 } },
  'emprestimo').status === 'em_atraso', 'past_due_instalments → em_atraso');
ok(S.normalizeDivida({ ...LOAN, product_sub_type: 'AQUISICAO_BENS_VEICULOS_AUTOMOTORES' },
  'financiamento').tipo === 'financiamento', 'veículo → financiamento');
console.log('  ok');

// ── 11. INVESTIMENTOS: os 5 tipos → aba Investimentos ─────────────────────
console.log('── 11. normalizeInvestimento() — 5 famílias ──');
const cdb = S.normalizeInvestimento({ __familia: 'bank_fixed_income', id: 'i1',
  brand_name: 'Itaú', investment_type: 'CDB',
  product: { isin_code: 'BRITAUCDB001', due_date: '2027-06-01', purchase_date: '2024-06-15',
    remuneration: { indexer: 'CDI', post_fixed_indexer_percentage: '1.020000' } },
  balance: { quantity: '10', updated_unit_price: { amount: '1180.00' },
    gross_amount: { amount: '11800.00' }, net_amount: { amount: '11500.00' },
    purchase_unit_price: { amount: '1000.00' } } });
ok(cdb.tipo === 'CDB', 'CDB/RDB/LCI/LCA → CDB');
ok(cdb.valor_atual === 11500, 'valor_atual = net_amount (LÍQUIDO), não gross');
ok(cdb.valor_aportado === 10000, 'aportado = qtd × purchase_unit_price');
ok(cdb.percentual_indexador === 102, '1.02 → 102% do CDI');
ok(cdb.data_vencimento === '2027-06-01', 'vencimento do título');
ok(quase(cdb.rentabilidade, 15), 'rentabilidade 15%');

const deb = S.normalizeInvestimento({ __familia: 'credit_fixed_income', id: 'i2',
  investment_type: 'DEBENTURES',
  product: { due_date: '2030-01-01', remuneration: { indexer: 'IPCA', pre_fixed_rate: '6.50', post_fixed_indexer_percentage: '100' } },
  balance: { quantity: '5', gross_amount: { amount: '5500.00' }, net_amount: { amount: '5300.00' },
    purchase_unit_price: { amount: '1000.00' } } });
ok(deb.tipo === 'Renda Fixa', 'DEBENTURES/CRI/CRA → Renda Fixa');
ok(deb.taxa_anual === 6.5 && deb.percentual_indexador === 100, 'IPCA + 6,5%');

const fun = S.normalizeInvestimento({ __familia: 'fund', id: 'i3', anbima_category: 'MULTIMERCADO',
  product: { name: 'BTG Absoluto FIC FIM', anbima_category: 'MULTIMERCADO' },
  balance: { quota_quantity: '1500.5', gross_amount: { amount: '18000.00' },
    net_amount: { amount: '17500.00' }, quota_gross_price_value: { amount: '12.00' } } });
ok(fun.tipo === 'Fundos', 'fund → Fundos');
ok(fun.quantidade === 1500.5 && fun.preco_unitario === 12, 'cotas e preço da cota');
ok(fun.setor === 'MULTIMERCADO', 'categoria ANBIMA vai em setor');
ok(fun.rentabilidade === 0, 'sem purchase_price → rentabilidade 0 (não inventar)');

const tes = S.normalizeInvestimento({ __familia: 'treasure_title', id: 'i4',
  product: { product_name: 'Tesouro Selic 2029', due_date: '2029-03-01', purchase_date: '2024-03-01',
    remuneration: { indexer: 'SELIC', post_fixed_indexer_percentage: '1.000000' } },
  balance: { quantity: '3.5', updated_unit_price: { amount: '15000.00' },
    gross_amount: { amount: '52500.00' }, net_amount: { amount: '51000.00' },
    purchase_unit_price: { amount: '12000.00' } } });
ok(tes.tipo === 'Tesouro Direto', 'treasure_title → Tesouro Direto');
ok(tes.nome === 'Tesouro Selic 2029', 'nome do produto');
ok(tes.valor_atual === 51000 && tes.valor_aportado === 42000, 'posição e aporte');

const acao = S.normalizeInvestimento({ __familia: 'variable_income', id: 'i5',
  product: { ticker: 'PETR4', isin_code: 'BRPETRACNPR6' },
  balance: { quantity: '100', gross_amount: { amount: '3800.00' }, closing_price: { amount: '38.00' } } });
ok(acao.tipo === 'Ações' && acao.ticker === 'PETR4', 'ticker comum → Ações');
ok(acao.valor_atual === 3800, 'renda variável não tem net_amount → usa gross');
ok(S.normalizeInvestimento({ __familia: 'variable_income', id: 'i6', product: { ticker: 'MXRF11' },
  balance: { gross_amount: { amount: '2000.00' } } }).tipo === 'FIIs', 'ticker …11 → FIIs');
ok(S.normalizeInvestimento({ __familia: 'fund', id: 'i7', product: { name: 'X' } }).valor_atual === null,
  'sem balance → valor null (o sync pula em vez de gravar 0)');
console.log('  ok');

// ── 12. Tipos têm de ser os que a aba de Investimentos conhece ─────────────
console.log('── 12. tipos aceitos pelo painel ──');
const TIPOS_PAINEL = ['Ações', 'FIIs', 'ETFs', 'Cripto', 'Tesouro Direto', 'CDB',
  'Previdência', 'Reserva', 'Imóveis', 'Negócio', 'Caixa', 'Renda Fixa', 'Fundos'];
for (const fam of ['bank_fixed_income', 'credit_fixed_income', 'fund', 'treasure_title', 'variable_income']) {
  const t = S.tipoInvestimento({ __familia: fam, product: {} });
  ok(TIPOS_PAINEL.includes(t), `família ${fam} → tipo "${t}" não existe no painel (CORES_TIPO)`);
}
console.log('  ok');

// ── 6C. SALDO = disponível + aplicação automática ─────────────────────────
// Relato de cliente: painel R$ 1,00 × app do Itaú R$ 2.541,12. O diagnóstico
// (?foco=saldo) mostrou de onde vinha a diferença — números REAIS abaixo:
//     available_amount ............... R$     1,00   ← era só isto que entrava
//     automatically_invested_amount .. R$ 2.541,17
// A doc da Celcoin diz que available_amount "não inclui (…) investimentos
// automáticos". O Itaú joga quase todo o saldo numa aplicação que volta
// sozinha quando o cliente gasta — é dinheiro disponível, e é o que o app soma.
console.log('── 6C. saldo com aplicação automática ──');
{
  const eqc = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);
  const conta = (balance) => ({ id: 'a1', type: 'CONTA_DEPOSITO_A_VISTA', brand_name: 'Itaú', balance });
  const brl = (v) => ({ amount: String(v), currency: 'BRL' });

  // ⚠️ O CASO REAL, ao centavo.
  const real = S.normalizeConta(conta({
    available_amount: brl('1.00'),
    automatically_invested_amount: brl('2541.17'),
    blocked_amount: brl('0.00'),
  }));
  eqc(real.saldo, 2542.17, 'saldo soma disponível + aplicado (o painel mostrava R$ 1,00)');
  eqc(real.extras.saldo_aplicado, 2541.17, 'guarda a parcela aplicada pra tela poder explicar');

  // Sem aplicação automática nada muda — a maioria das contas cai aqui.
  const simples = S.normalizeConta(conta({ available_amount: brl('850.30') }));
  eqc(simples.saldo, 850.30, 'conta sem aplicação automática segue igual');
  eqc(simples.extras.saldo_aplicado, null, 'sem aplicação o campo é null, não 0');

  // ⚠️⚠️ E TEM EMISSOR QUE NÃO CUMPRE O CONTRATO. O Mercado Pago manda O MESMO
  // DINHEIRO nos dois campos, e a soma DOBRAVA o saldo do cliente: painel
  // R$ 4.414,32 contra R$ 2.207,16 no app. A aritmética não deixa outra
  // leitura — se disponível + aplicado = 4.414,32 e o certo é exatamente
  // metade, os dois campos valem 2.207,16 cada. O sinal é a igualdade AO
  // CENTAVO: em conta de pagamento o saldo inteiro rende, então os dois
  // coincidirem é estrutural, não coincidência.
  const mp = S.normalizeConta(conta({
    available_amount: brl('2207.16'),
    automatically_invested_amount: brl('2207.16'),
    blocked_amount: brl('0.00'),
  }));
  eqc(mp.saldo, 2207.16, 'campos iguais = mesmo dinheiro contado duas vezes, NÃO soma');
  eqc(mp.extras.saldo_aplicado, 2207.16, 'mas a parcela aplicada continua informada');

  // Um centavo de diferença já é dinheiro de verdade em dois lugares.
  const quase = S.normalizeConta(conta({
    available_amount: brl('100.00'), automatically_invested_amount: brl('100.01'),
  }));
  eqc(quase.saldo, 200.01, 'quase iguais NÃO é o mesmo dinheiro: soma');

  // Zerado dos dois lados não pode virar "duplicado" e sumir com nada.
  const zerado = S.normalizeConta(conta({
    available_amount: brl('0.00'), automatically_invested_amount: brl('0.00'),
  }));
  eqc(zerado.saldo, 0, 'conta zerada segue zerada');

  // ⚠️ BLOQUEADO CONTINUA FORA: não é gastável.
  const comBloqueio = S.normalizeConta(conta({
    available_amount: brl('100.00'),
    automatically_invested_amount: brl('50.00'),
    blocked_amount: brl('999.00'),
  }));
  eqc(comBloqueio.saldo, 150, 'blocked_amount NÃO entra no saldo');

  // Conta com o disponível zerado — o caso extremo do Itaú.
  const soAplicado = S.normalizeConta(conta({
    available_amount: brl('0.00'), automatically_invested_amount: brl('4000.00'),
  }));
  eqc(soAplicado.saldo, 4000, 'saldo todo aplicado ainda é saldo');

  // ⚠️ Sem balance = NÃO SINCRONIZADO. Não pode virar 0, senão a conta
  // apareceria zerada em vez de "aguardando o banco".
  const semBalance = S.normalizeConta({ id: 'a2', type: 'CONTA_DEPOSITO_A_VISTA' });
  eqc(semBalance.saldo, null, 'sem balance o saldo é null, nunca 0');
  eqc(semBalance.sincronizado, false, '…e a conta fica marcada como não sincronizada');

  // Centavos não podem acumular erro de float.
  const centavos = S.normalizeConta(conta({
    available_amount: brl('0.10'), automatically_invested_amount: brl('0.20'),
  }));
  eqc(centavos.saldo, 0.3, '0,10 + 0,20 = 0,30 (sem dízima de float)');
}
console.log('  ok');

// ── 6B. Nome da conta: brand_name → instituição do consent → "Banco" ──────
// `brand_name` vem vazio em parte das contas e a carteira nascia chamada
// literalmente "Banco" (medido: 4 carteiras assim, 779 transações). Virou
// relato de cliente. O consentimento sabe a instituição — ela é o 2º recurso.
console.log('── 6B. nome da conta (fallback de brand_name) ──');
{
  const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);
  const conta = (extra) => ({ id: 'a1', type: 'CONTA_DEPOSITO_A_VISTA', ...extra });

  eq(S.normalizeConta(conta({ brand_name: 'Nubank' }), 'Itaú').nome, 'Nubank',
    'brand_name manda quando existe');
  eq(S.normalizeConta(conta({}), 'Nubank').nome, 'Nubank',
    'sem brand_name usa a instituição do consentimento');
  eq(S.normalizeConta(conta({ brand_name: '' }), 'Bradesco').nome, 'Bradesco',
    'brand_name VAZIO também cai pra instituição');
  eq(S.normalizeConta(conta({}), null).nome, 'Banco',
    '"Banco" só quando não há nem instituição');
  // Poupança mantém o sufixo em qualquer um dos caminhos.
  eq(S.normalizeConta(conta({ type: 'CONTA_POUPANCA' }), 'Nubank').nome, 'Nubank Poupança',
    'sufixo de poupança preservado no fallback');
}
console.log('  ok');

// ── 8B. Descrição do PIX: contraparte vence o nome genérico ───────────────
// Relato de cliente: "os lançamentos de PIX não trazem um descritivo de para
// onde o pix foi feito, dificultando a revisão manual das categorias".
// Medido na conta dele: 115 de 377 transações com a descrição literal "Pix".
// Causa: a ordem era `transaction_name || counterparty` — e como o banco manda
// `transaction_name: "Pix"` em todo pix, a contraparte NUNCA era usada.
console.log('── 8B. descrição do PIX (contraparte) ──');
{
  const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);
  const d = (tx) => S.descricaoTx(tx);

  // O caso que estava quebrado: genérico + contraparte real → usa a contraparte.
  eq(d({ transaction_name: 'Pix', counterparty: { alias: 'Netflix', name: 'NETFLIX ENTRETENIMENTO BRASIL LTDA.' } }),
     'Pix · Netflix', 'genérico + contraparte → mostra os dois');
  // `alias` (nome fantasia) antes de `name` (razão social) — mais legível.
  eq(d({ transaction_name: 'Compra', counterparty: { alias: 'iFood', name: 'IFOOD COM AGENCIA LTDA' } }),
     'Compra · iFood', 'alias vence razão social');
  eq(d({ transaction_name: 'Pix', counterparty: { name: 'PADARIA CENTRAL LTDA' } }),
     'Pix · PADARIA CENTRAL LTDA', 'cai na razão social quando não há alias');

  // Descrição que JÁ diz algo não pode ser estragada.
  eq(d({ transaction_name: 'Pix recebido - Vander Nelson Sposito' }),
     'Pix recebido - Vander Nelson Sposito', 'descrição específica é preservada');
  eq(d({ transaction_name: 'MERCADO LIVRE*COMPRA' }), 'MERCADO LIVRE*COMPRA', 'nome de loja preservado');

  // ⚠️ A doc avisa: contraparte só é enriquecida com CNPJ. Pix pra PESSOA
  // FÍSICA nunca terá nome — o melhor possível é tipo + documento mascarado.
  eq(d({ transaction_name: 'Pix', partie_cnpj_cpf: '12345678901' }),
     'Pix · •••.456.789-••', 'sem contraparte, mostra o CPF mascarado');
  eq(d({ transaction_name: 'Pix', partie_cnpj_cpf: '13487809000140' }),
     'Pix · 13.487.809/••••-••', 'CNPJ mascarado quando não houve enrichment');

  // `type_additional_info` entra antes do documento quando diz algo.
  eq(d({ transaction_name: 'Pix', type_additional_info: 'Aluguel agosto' }),
     'Pix · Aluguel agosto', 'informação adicional é aproveitada');

  // Nada de nada → não pode virar string vazia.
  ok(d({}).length > 0, 'sem dado nenhum ainda devolve algo');
  eq(d({ transaction_name: 'Pix' }), 'Pix', 'genérico sem mais nada continua "Pix"');

  // ⚠️ NÃO pode ficar pior que antes: descrição nunca vazia.
  for (const tx of [{}, { transaction_name: '' }, { transaction_name: 'Pix' }, { counterparty: {} }]) {
    ok(typeof d(tx) === 'string' && d(tx).trim().length > 0, `descrição nunca vazia: ${JSON.stringify(tx)}`);
  }

  // A mascara não pode vazar o documento inteiro.
  const masc = S.documentoMascarado('12345678901');
  ok(!masc.includes('123'), 'CPF mascarado não mostra os 3 primeiros dígitos');
  eq(S.documentoMascarado('123'), null, 'documento inválido não vira máscara');
}
console.log('  ok');

// ── 12B. Produto na RAIZ vence o `product` legado ─────────────────────────
// A doc (versão atual): "Campos de `product` passam a existir na raiz. O objeto
// `product` aninhado é LEGADO" e "pode retornar null se o Product Identification
// ainda não foi sincronizado". Lendo só o legado, o investimento perdia ticker,
// nome e datas de uma vez — e em renda variável um FII virava "Ações".
console.log('── 12B. produto na raiz (product legado = null) ──');
{
  const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

  // Só a RAIZ (product null) — o formato novo.
  const raiz = {
    __familia: 'variable_income', id: 'vi-1', ticker: 'MXRF11',
    isin_code: 'BRMXRFCTF002', product: null,
    balance: { quantity: '10.000000', gross_amount: { amount: '105.70', currency: 'BRL' } },
  };
  eq(S.tipoInvestimento(raiz), 'FIIs', 'ticker da raiz classifica como FII');
  const n = S.normalizeInvestimento(raiz);
  eq(n.ticker, 'MXRF11', 'ticker vem da raiz');
  eq(n.valor_atual, 105.7, 'posição preservada');

  // Só o LEGADO — formato antigo continua funcionando (sem regressão).
  const legado = {
    __familia: 'variable_income', id: 'vi-2',
    product: { ticker: 'XPML11', isin_code: 'BRXPMLCTF001' },
    balance: { gross_amount: { amount: '309.33', currency: 'BRL' } },
  };
  eq(S.tipoInvestimento(legado), 'FIIs', 'ticker do product legado ainda vale');
  eq(S.normalizeInvestimento(legado).ticker, 'XPML11', 'ticker do legado preservado');

  // Os dois presentes e divergentes → a RAIZ manda.
  const ambos = {
    __familia: 'variable_income', id: 'vi-3', ticker: 'GARE11',
    product: { ticker: 'ANTIGO4' },
    balance: { gross_amount: { amount: '89.54', currency: 'BRL' } },
  };
  eq(S.normalizeInvestimento(ambos).ticker, 'GARE11', 'raiz vence o legado');
  eq(S.tipoInvestimento(ambos), 'FIIs', 'e a classificação segue a raiz');

  // Renda fixa: remuneração na raiz também precisa ser lida.
  const rf = {
    __familia: 'bank_fixed_income', id: 'rf-1', product: null,
    name: 'CDB Banco X', due_date: '2027-01-10',
    remuneration: { indexer: 'CDI', post_fixed_indexer_percentage: '1.020000' },
    balance: { net_amount: { amount: '1000.00', currency: 'BRL' } },
  };
  const nrf = S.normalizeInvestimento(rf);
  eq(nrf.indexador, 'CDI', 'indexador da raiz');
  eq(nrf.percentual_indexador, 102, '1.02 → 102% do CDI');
  eq(nrf.data_vencimento, '2027-01-10', 'vencimento da raiz');
}
console.log('  ok');

// ── 13. Fatura EM ABERTO: o banco não publica o total ─────────────────────
// Caso real (Mercado Pago, jul/2026): 26 compras importadas e o painel mostrava
// "R$ 0,00", porque `bill_total_amount` só é publicado quando o ciclo FECHA.
console.log('── 13. fatura em aberto (sem total do banco) ──');
{
  const HOJE = '2026-07-30';
  const card = { id: 'c1', identification: { name: 'Mercado Pago' }, limits: [] };
  const n = S.normalizeCartao(card, [{
    id: 'b-ago', bill_total_amount: null, bill_minimum_amount: { amount: '3.13' },
    bill_closing_date: '2026-08-12', due_date: '2026-08-17', payments: [],
  }], HOJE);
  ok(n.extras.dia_fechamento === 12, 'fechamento tem de vir do banco (a Pluggy mandava null)');
  ok(n.extras.dia_vencimento === 17, 'vencimento do banco');
  ok(n.saldoFatura === null, 'sem total publicado → saldo INDEFINIDO (≠ zero)');

  // Ciclo 13/07–12/08: a de 10/07 é da fatura passada; pagamento não é gasto.
  const crus = [
    { id: 't1', transaction_date_time: '2026-07-29T22:13:00Z', brazilian_amount: { amount: '117.34' }, transaction_name: 'FACEBK', credit_debit_type: 'DEBITO' },
    { id: 't2', transaction_date_time: '2026-07-14T10:00:00Z', brazilian_amount: { amount: '100.00' }, transaction_name: 'LOJA', credit_debit_type: 'DEBITO' },
    { id: 't3', transaction_date_time: '2026-07-10T10:00:00Z', brazilian_amount: { amount: '999.00' }, transaction_name: 'CICLO ANTERIOR', credit_debit_type: 'DEBITO' },
    { id: 't4', transaction_date_time: '2026-07-20T10:00:00Z', brazilian_amount: { amount: '50.00' }, transaction_name: 'PAGAMENTO', transaction_type: 'PAGAMENTO_FATURA', credit_debit_type: 'CREDITO' },
  ];
  const norm = crus.map((t) => S.normalizeTxCartao(t, HOJE));
  ok(S.faturaPorTransacoes(norm, crus, n, HOJE) === 217.34, 'soma pelo CICLO real, só gastos');

  // `bill_id` é o agrupamento do próprio emissor — manda sobre a nossa aritmética.
  const comBill = crus.map((t, i) => ({ ...t, bill_id: i === 3 ? 'b-jul' : 'b-ago' }));
  ok(S.faturaPorTransacoes(comBill.map((t) => S.normalizeTxCartao(t, HOJE)), comBill, n, HOJE) === 1216.34,
    'bill_id tem prioridade sobre o ciclo');

  // Fatura já fechada: o total do banco é a verdade (e desconta o que foi pago).
  const fechada = S.normalizeCartao(card, [{
    id: 'b', bill_total_amount: { amount: '2845.20' }, bill_closing_date: '2026-08-12',
    due_date: '2026-08-17', payments: [{ amount: { amount: '845.20' } }],
  }], HOJE);
  ok(fechada.saldoFatura === -2000, 'com total publicado: saldo = −(total − pago)');

  // Sem fechamento e sem bill_id não dá pra agrupar — não inventar número.
  ok(S.faturaPorTransacoes(norm, crus, S.normalizeCartao(card, [], HOJE), HOJE) === null,
    'sem dia_fechamento → null (não estimar às cegas)');

  // Pré-autorização não entra na fatura. Caso real: o gateway manda a
  // autorização E a captura, com IDs distintos e centavos diferentes.
  const preAut = { id: 'p1', transaction_date_time: '2026-07-14T00:14:02Z', credit_debit_type: 'DEBITO',
    brazilian_amount: { amount: '139.99' }, transaction_name: 'PayU *ADI',
    completed_authorised_payment_type: 'TRANSACAO_PROCESSANDO' };
  const captura = { ...preAut, id: 'p2', brazilian_amount: { amount: '140.00' },
    transaction_name: 'PayU *ADIDAS', completed_authorised_payment_type: 'TRANSACAO_EFETIVADA' };
  ok(S.normalizeTxCartao(preAut, HOJE) === null, 'TRANSACAO_PROCESSANDO não entra na fatura');
  ok(S.normalizeTxCartao(captura, HOJE) && S.normalizeTxCartao(captura, HOJE).valor === 140,
    'a captura efetivada entra normalmente');
  ok(S.normalizeTxConta({ id: 'c1', transaction_amount: { amount: '10.00' }, credit_debit_type: 'DEBITO',
    completed_authorised_payment_type: 'TRANSACAO_PROCESSANDO' }) === null,
    'mesma regra na conta corrente');
}
console.log('  ok');

console.log(`\n${falhas.length ? `${falhas.length} FALHA(S) ❌` : 'tudo passou ✅'}`);
if (falhas.length) {
  console.log('\n── Falhas ──');
  falhas.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}
