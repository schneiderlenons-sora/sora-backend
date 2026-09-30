// =============================================================================
// QUANTO DAS PARCELAS DE DÍVIDA **NÃO** APARECE NOS GASTOS.
//
// POR QUE EXISTE (26/09/2026). Relato de cliente (Marcelo): "na parte de conta
// de reserva ele não está considerando o que tem em dívidas e parcelas".
//
// Ele está certo, e o erro é grande. A meta da reserva de emergência sai de
// `gasto médio dos últimos 6 meses × N meses`, e esse gasto médio só enxerga
// TRANSAÇÃO. Na conta dele havia três financiamentos (Jeep, casa, Golf)
// somando **R$ 6.296,91 por mês** — mais que todo o resto do custo de vida
// dele — e ZERO pagamentos lançados. Medido:
//
//     gasto médio hoje ......... R$  4.929,64/mês  → meta 6m: R$ 29.577,83
//     com as parcelas .......... R$ 11.226,55/mês  → meta 6m: R$ 67.359,29
//
// Se ele perder a renda amanhã, continua devendo as três parcelas. Uma reserva
// dimensionada sem elas cobre pouco mais da metade do que promete.
//
// ⚠️ O PERIGO AQUI É CONTAR EM DOBRO, e ele é maior que o bug original.
// Medido nas 103 dívidas ativas da base: em **28** o pagamento JÁ vira
// transação. Somar a parcela por cima delas inflaria a meta de quem está certo
// — e a tela já grita "CRÍTICO" em vermelho. Por isso a regra abaixo é
// ESTREITA: só entra dívida que, comprovadamente, não deixou rastro nos gastos.
// =============================================================================

/** Mesma normalização usada no resto do projeto: minúsculas, sem acento. */
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Categorias em que um pagamento de dívida costuma ser lançado à mão. */
const CATEGORIAS_DIVIDA = new Set(['dividas', 'emprestimos', 'emprestimo', 'financiamento']);

/**
 * ⚠️ ROTATIVO DO CARTÃO FICA DE FORA. Ele é cobrado DENTRO da fatura, e a
 * fatura já é composta por transações — somar a parcela por cima contaria o
 * mesmo dinheiro duas vezes. São 20 das 103 dívidas ativas da base.
 */
const TIPOS_FORA = new Set(['cartao_rotativo']);

/** A dívida ainda gera parcela nos próximos meses? */
function estaAtiva(d) {
  if (!d || d.status === 'quitada') return false;
  if (!(Number(d.valor_parcela) > 0)) return false;
  // Sem total de parcelas não dá pra saber se acabou — trata como ativa, que é
  // o lado que o usuário vê na aba Dívidas.
  if (d.parcelas_total && (d.parcelas_pagas || 0) >= d.parcelas_total) return false;
  return true;
}

/**
 * Esta dívida já aparece nos gastos?
 *
 * Dois sinais, os dois estreitos de propósito:
 *
 *  a) a descrição EXATA que o nosso próprio `debitarConta` escreve ao pagar a
 *     dívida com conta de débito ("Pagamento: <título>"). Não é heurística —
 *     é a string que o código gera.
 *  b) lançamento numa categoria de dívida com valor batendo na parcela (±2%).
 *
 * ⚠️ NÃO VALE "a descrição CONTÉM o título". Na conta do relato existe uma
 * dívida chamada "Golf" e uma compra "MERCADOLIVRE*Tapete Golf": por "contém",
 * o tapete faria o financiamento do carro parecer pago, e a parcela de
 * R$ 1.092,35 sumiria da meta em silêncio.
 */
function jaApareceNosGastos(divida, transacoes) {
  // ⚠️ SEM TÍTULO, O SINAL (a) NÃO EXISTE. `norm('pagamento ')` é só
  // "pagamento", e aí QUALQUER lançamento chamado "Pagamento" cancelaria a
  // dívida. O eval pegou isso: sem esta guarda, uma dívida sem título somava 0.
  const titulo = norm(divida.titulo || '');
  const alvo = titulo ? `pagamento ${titulo}` : null;
  const parcela = Number(divida.valor_parcela) || 0;
  const tolerancia = Math.max(1, parcela * 0.02);

  for (const t of transacoes || []) {
    if (alvo && norm(t.observacao) === alvo) return true;
    if (CATEGORIAS_DIVIDA.has(norm(t.categoria))
        && Math.abs((Number(t.valor) || 0) - parcela) <= tolerancia) return true;
  }
  return false;
}

/**
 * O custo mensal de dívidas que o gasto médio NÃO está enxergando.
 *
 * @param dividas    linhas de `dividas` do grupo
 * @param transacoes gastos do mesmo período usado no gasto médio, JÁ sem
 *                   transferências (quem filtra é a rota, com a regra canônica)
 */
function custoMensalDividas({ dividas, transacoes }) {
  const consideradas = [];
  const jaNosGastos = [];

  for (const d of dividas || []) {
    if (!estaAtiva(d)) continue;
    if (TIPOS_FORA.has(String(d.tipo || ''))) continue;

    // ⚠️ DÍVIDA DO OPEN FINANCE NÃO ENTRA. A parcela dela é debitada na conta
    // corrente, e essa conta é sincronizada — ou seja, o débito JÁ chega como
    // transação, com a descrição do banco (que nunca vai casar com o título).
    // São 16 das 103 ativas, R$ 25.916,95/mês: somá-las seria o maior erro
    // possível aqui, e do lado de inflar a meta.
    if (d.origem && d.origem !== 'manual') continue;

    const linha = {
      id: d.id,
      titulo: d.titulo || d.credor || 'Dívida',
      valor: Number(d.valor_parcela) || 0,
      tipo: d.tipo || null,
    };
    if (jaApareceNosGastos(d, transacoes)) jaNosGastos.push(linha);
    else consideradas.push(linha);
  }

  consideradas.sort((a, b) => b.valor - a.valor);
  const parcelaMensal = consideradas.reduce((s, l) => s + l.valor, 0);

  return { parcelaMensal, consideradas, jaNosGastos };
}

module.exports = { custoMensalDividas, jaApareceNosGastos, estaAtiva, norm };
