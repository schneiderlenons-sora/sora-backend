// =============================================================================
// EVAL da redistribuição de PARCELAS do cartão no Open Finance (Celcoin).
//
// ESCRITO A PARTIR DE UM BUG REAL, com os números da conta que o expôs:
// uma compra na Amazon de 03/08/2026 em 12x R$29,90 virou DOZE gastos de
// R$29,90 no dia 03/08 — porque a Celcoin manda as N parcelas como N
// transações, todas carimbadas com a data da COMPRA, e o sync só descartava
// transação com data FUTURA.
//
// Medido nessa conta antes da correção:
//   16 compras parceladas · 47 linhas · R$ 2.055,67 inflados no histórico
//   R$ 380,40 inflados só no ciclo aberto (07/2026–08/2026)
//
// Rodar:  npm run eval:parcela-cartao
// =============================================================================
const {
  parcelaDaDescricao, parcelaDaTx, dataDaParcela, grupoDaParcela, normalizeTxCartao,
} = require('../src/services/polpCelcoinSync');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(a === b, `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);
const dia = (iso) => String(iso || '').slice(0, 10);

// ── 1. Ler o marcador "N/M" ────────────────────────────────────────────────
console.log('── 1. marcador de parcela ──');
{
  const p = parcelaDaDescricao('Amazon Br Digital 3/12');
  eq(p.base, 'Amazon Br Digital', 'base sem o marcador');
  eq(p.n, 3, 'número da parcela');
  eq(p.total, 12, 'total de parcelas');

  eq(parcelaDaDescricao('Shein *Belo Diamante 1/3').n, 1, 'primeira parcela');
  eq(parcelaDaDescricao('Mercadolivre*Mercadol 5/5').n, 5, 'última parcela');

  // Não é parcelamento
  eq(parcelaDaDescricao('Uber *Trip'), null, 'compra à vista não tem marcador');
  eq(parcelaDaDescricao('Posto 1/1'), null, '"1/1" não é parcelamento');
  eq(parcelaDaDescricao(''), null, 'vazio');
  eq(parcelaDaDescricao(null), null, 'null não quebra');
  eq(parcelaDaDescricao('13/12'), null, 'sem descrição antes do marcador');
  eq(parcelaDaDescricao('Loja 13/12'), null, 'parcela maior que o total é lixo');

  // O marcador tem de estar NO FIM — data no meio não pode virar parcela.
  eq(parcelaDaDescricao('Conta de 03/08 quitada'), null, 'data no meio não é marcador');
}
console.log('  ok');

// ── 1b. Campo estruturado tem PRIORIDADE sobre o texto ─────────────────────
// A Celcoin publica charge_identificator (parcela) e charge_number (total) —
// docs/CELCOIN-API.md §5.2. Depender do texto seria frágil: nem todo emissor
// escreve "3/12" no nome da transação.
console.log('── 1b. campo estruturado > descrição ──');
{
  const porCampo = parcelaDaTx({ charge_identificator: 3, charge_number: 12 }, 'Amazon Br Digital');
  eq(porCampo.n, 3, 'lê charge_identificator');
  eq(porCampo.total, 12, 'lê charge_number');
  eq(porCampo.fonte, 'campo', 'marca a origem como campo');
  eq(porCampo.base, 'Amazon Br Digital', 'base sem marcador');

  // Com os dois presentes, o campo vence.
  const ambos = parcelaDaTx({ charge_identificator: 3, charge_number: 12 }, 'Amazon Br Digital 3/12');
  eq(ambos.fonte, 'campo', 'campo tem prioridade sobre o texto');
  eq(ambos.base, 'Amazon Br Digital', 'e o marcador sai da base mesmo assim');

  // Sem os campos, cai no texto.
  eq(parcelaDaTx({}, 'Shein *Sg Gabriel 2/2').fonte, 'descricao', 'sem campo, usa a descrição');
  eq(parcelaDaTx({}, 'Uber *Trip'), null, 'sem campo e sem marcador não é parcela');

  // "1/1" pelo campo também não é parcelamento.
  eq(parcelaDaTx({ charge_identificator: 1, charge_number: 1 }, 'Posto'), null, 'charge_number 1 não é parcelamento');
}
console.log('  ok');

// ── 2. Data da parcela = compra + (N−1) meses ──────────────────────────────
console.log('── 2. data de cobrança ──');
{
  const compra = '2026-08-03T21:39:07.001Z';
  eq(dia(dataDaParcela(compra, 1)), '2026-08-03', 'parcela 1 fica na data da compra');
  eq(dia(dataDaParcela(compra, 2)), '2026-09-03', 'parcela 2 no mês seguinte');
  eq(dia(dataDaParcela(compra, 12)), '2027-07-03', 'parcela 12 vira o ano');

  // Clamp em 28 — mesma regra do parcelamento manual (handlers/parcelas.js).
  const dia31 = '2026-01-31T12:00:00Z';
  eq(dia(dataDaParcela(dia31, 1)), '2026-01-28', 'dia 31 é clampado pra 28');
  eq(dia(dataDaParcela(dia31, 2)), '2026-02-28', 'e fevereiro não estoura pra março');
  eq(dia(dataDaParcela(dia31, 3)), '2026-03-28', 'março segue no 28');

  // Meio-dia UTC: no fuso de SP (UTC−3) o dia tem de continuar o mesmo.
  const emSP = new Date(dataDaParcela(compra, 2)).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  eq(emSP, '2026-09-03', 'ancorado ao meio-dia: não vira o dia no fuso de SP');

  // ⚠️ REGRESSÃO REAL: a compra da Amazon foi 03/08 às 21h39 no Brasil, e o
  // emissor manda isso como 2026-08-04T00:39:07Z. Ler o dia em UTC jogaria as
  // 12 parcelas pro dia 04 — um dia depois do que o cliente vê na fatura.
  const noiteBR = '2026-08-04T00:39:07.001Z'; // = 03/08 21h39 em São Paulo
  eq(dia(dataDaParcela(noiteBR, 1)), '2026-08-03', 'compra às 21h BR usa o dia de SP, não o de UTC');
  eq(dia(dataDaParcela(noiteBR, 2)), '2026-09-03', 'e as parcelas seguem o dia 3, não o 4');
  eq(dia(dataDaParcela(noiteBR, 12)), '2027-07-03', 'até a última');

  eq(dataDaParcela('data-invalida', 2), null, 'data inválida devolve null');
}
console.log('  ok');

// ── 3. Grupo determinístico ────────────────────────────────────────────────
// É o que faz "excluir todas", a badge "3/12" e a exclusão da detecção de
// recorrência funcionarem — parcelas chegam em syncs diferentes.
console.log('── 3. grupo do parcelamento ──');
{
  const a = grupoDaParcela('Amazon Br Digital', 12, 29.90, '2026-08-03T21:39:07Z');
  const b = grupoDaParcela('Amazon Br Digital', 12, 29.90, '2026-08-03T21:39:07Z');
  eq(a, b, 'mesma compra → mesmo grupo (determinístico)');

  // Centavos diferentes entre parcelas da MESMA compra (medido: 52,19/52,20/52,23)
  const c1 = grupoDaParcela('Mercadolivre*Mercadol', 5, 52.19, '2026-05-29T10:00:00Z');
  const c2 = grupoDaParcela('Mercadolivre*Mercadol', 5, 52.23, '2026-05-29T10:00:00Z');
  eq(c1, c2, 'centavo diferente NÃO quebra a compra em dois grupos');

  // Caixa da descrição não pode separar (o emissor manda "Shein" e "SHEIN").
  eq(grupoDaParcela('Shein *Belo Diamante', 3, 120.77, '2026-05-07T10:00:00Z'),
     grupoDaParcela('SHEIN *BELO DIAMANTE', 3, 120.77, '2026-05-07T10:00:00Z'),
     'maiúscula/minúscula não separa');

  // Mas compras realmente diferentes continuam separadas.
  ok(a !== grupoDaParcela('Outra Loja', 12, 29.90, '2026-08-03T21:39:07Z'), 'loja diferente separa');
  ok(a !== grupoDaParcela('Amazon Br Digital', 6, 29.90, '2026-08-03T21:39:07Z'), 'nº de parcelas diferente separa');
  ok(a !== grupoDaParcela('Amazon Br Digital', 12, 99.90, '2026-08-03T21:39:07Z'), 'valor diferente separa');
  ok(a !== grupoDaParcela('Amazon Br Digital', 12, 29.90, '2026-07-03T21:39:07Z'), 'data diferente separa');
}
console.log('  ok');

// ── 4. O CASO REAL: as 12 da Amazon ────────────────────────────────────────
console.log('── 4. compra real da Amazon (12x R$29,90 em 03/08) ──');
{
  const HOJE = '2026-08-05';
  // Como a Celcoin manda: 12 linhas, TODAS com a data da compra.
  const crus = Array.from({ length: 12 }, (_, i) => ({
    id: `tx-${i + 1}`,
    transaction_name: `Amazon Br Digital ${i + 1}/12`,
    transaction_date_time: '2026-08-03T21:39:07.001Z',
    brazilian_amount: { amount: '29.90', currency: 'BRL' },
    credit_debit_type: 'DEBITO',
    charge_identificator: i + 1,
    charge_number: 12,
  }));

  const norm = crus.map((t) => normalizeTxCartao(t, HOJE));
  eq(norm.filter(Boolean).length, 12, 'as 12 continuam sendo importadas (nenhuma se perde)');

  const datas = norm.map((t) => dia(t.data));
  eq(new Set(datas).size, 12, 'cada parcela numa data diferente (era 1 só — o bug)');
  eq(datas[0], '2026-08-03', 'parcela 1 na compra');
  eq(datas[1], '2026-09-03', 'parcela 2 em setembro');
  eq(datas[11], '2027-07-03', 'parcela 12 em julho/2027');

  // O ponto do bug: quanto cai na fatura aberta (ciclo 08/07 a 07/08).
  const noCiclo = norm.filter((t) => dia(t.data) >= '2026-07-08' && dia(t.data) < '2026-08-08');
  eq(noCiclo.length, 1, 'só UMA parcela na fatura aberta');
  eq(noCiclo[0].valor, 29.9, 'e ela vale R$29,90 — não R$358,80');

  // Metadados de parcela preenchidos (colunas da migration 071).
  eq(norm[2].parcelaNum, 3, 'parcela_num gravado');
  eq(norm[2].parcelaTotal, 12, 'parcela_total gravado');
  eq(new Set(norm.map((t) => t.parcelaGrupo)).size, 1, 'as 12 no MESMO parcela_grupo');
  ok(norm[0].parcelaGrupo, 'grupo não é nulo');

  // Parcela já cobrada nasce paga; a que ainda vem, não (conta como prevista).
  eq(norm[0].pago, true, 'parcela do mês nasce paga');
  eq(norm[1].pago, false, 'parcela futura nasce NÃO paga');
  eq(norm[11].pago, false, 'a última também');
}
console.log('  ok');

// ── 5. Não pode regredir o resto ───────────────────────────────────────────
console.log('── 5. o que NÃO pode mudar ──');
{
  const HOJE = '2026-08-05';
  const base = {
    id: 'x', brazilian_amount: { amount: '50.00' }, credit_debit_type: 'DEBITO',
  };

  // Compra à vista no futuro continua FORA (viraria "gasto em 2027").
  eq(normalizeTxCartao({ ...base, transaction_name: 'Uber *Trip', transaction_date_time: '2027-03-13T10:00:00Z' }, HOJE),
     null, 'transação futura SEM marcador continua descartada');

  // À vista no passado entra normal, sem virar parcela.
  const avista = normalizeTxCartao({ ...base, transaction_name: 'Uber *Trip', transaction_date_time: '2026-08-01T10:00:00Z' }, HOJE);
  eq(dia(avista.data), '2026-08-01', 'compra à vista mantém a data');
  eq(avista.parcelaNum, null, 'e não ganha metadado de parcela');
  eq(avista.pago, true, 'e nasce paga, como sempre');

  // Parcela que o emissor JÁ datou no futuro continua descartada — é o caso
  // que o eval do celcoinSync trava desde antes, e ele está certo:
  // essa linha é devolvida em TODO sync (a data dela é sempre > fromDate),
  // então entra sozinha quando a data chegar. Só a parcela que NÓS
  // redistribuímos precisa entrar adiantada, porque ela carrega a data da
  // compra e sairia da janela de 90 dias antes de ser cobrada.
  eq(normalizeTxCartao(
    { ...base, transaction_name: 'Hoteis.com 12/12', transaction_date_time: '2027-03-13T10:00:00Z' }, HOJE),
    null, 'parcela já datada no futuro NÃO é importada adiantada');

  // Pagamento de fatura continua transferência e SEM grupo de parcela.
  const pag = normalizeTxCartao(
    { ...base, transaction_name: 'Pagamento 1/2', transaction_type: 'PAGAMENTO_FATURA',
      transaction_date_time: '2026-08-01T10:00:00Z' }, HOJE);
  eq(pag.transferencia, true, 'pagamento de fatura segue transferência');
  eq(pag.parcelaGrupo, null, 'e não vira parcelamento');

  // Pré-autorização continua fora.
  eq(normalizeTxCartao({ ...base, transaction_name: 'X 1/2', completed_authorised_payment_type: 'TRANSACAO_PROCESSANDO',
      transaction_date_time: '2026-08-01T10:00:00Z' }, HOJE), null, 'não efetivada segue descartada');
}
console.log('  ok');

// ── Resultado ──────────────────────────────────────────────────────────────
console.log('');
if (falhas.length) {
  console.error(`✗ ${falhas.length} falha(s):`);
  falhas.forEach((f) => console.error('  ·', f));
  process.exit(1);
}
console.log('✓ parcelas do cartão OF: todos os casos passaram');
