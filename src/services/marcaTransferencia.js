// =============================================================================
// MARCAR / DESMARCAR "TRANSFERÊNCIA ENTRE MINHAS CONTAS" NA EDIÇÃO — regra pura.
//
// Relato (Breno, nov/2026): o Bradesco manda o pagamento do financiamento
// imobiliário (TED pro Itaú, ~R$ 3.075 todo mês) classificado como
// "transferência entre contas". A Sora marca `transferencia = true` e a linha
// sai dos gastos. Ele trocou a categoria pra "Financiamento", mas a marca
// continuou — e a tela de edição NÃO tinha como tirá-la: "não consigo alterar".
// O caso inverso também existe: o Pix pra si mesmo que o banco NÃO marca.
//
// Esta regra decide quando a pessoa pode trocar a marca de UMA linha pela
// edição. Estreita de propósito:
//
//   · SÓ LINHA DO BANCO (`of_tx_id`). É o banco que classifica errado; e conta
//     do Open Finance nunca tem saldo mexido à mão (regra de ouro), então
//     trocar a marca não move dinheiro nenhum. Em lançamento manual a marca
//     decide se o saldo andou — trocá-la aqui deixaria o saldo errado. Pra esses
//     existe "Transferir entre contas".
//   · NUNCA EM CARTÃO: em carteira de crédito, crédito marcado como
//     transferência é pagamento de fatura (services/valorFatura.js) — trocar a
//     marca mexeria no VALOR DA FATURA.
//   · NUNCA EM PAGAMENTO DE FATURA nem AJUSTE DE SALDO: esses ficam fora das
//     somas pela CATEGORIA (resumoTransacoes.ehTransferencia); tirar a marca não
//     mudaria nada, e contar o pagamento da fatura somaria o gasto em dobro.
//   · TIRAR A MARCA COM A CATEGORIA "Transferências" NÃO VALE: a categoria
//     sozinha já tira a linha das somas. Sem escolher outra categoria, "não é
//     transferência" salvaria e nada mudaria na tela — pede a categoria.
//
// eval: npm run eval:marca-transferencia
// =============================================================================
const { ehPagamentoFatura, ehPagamentoFaturaLegado, ehAjusteSaldo } = require('./categorizar');

const ehCartao = (carteira) => /cr[eé]dito/i.test(String((carteira && carteira.tipo) || ''));

/**
 * @param {object}  p
 * @param {object}  p.antes             a linha como está no banco
 * @param {object?} p.carteira          a carteira dela ({ tipo }), ou null
 * @param {*}       p.transferencia     o que a pessoa pediu (tem de ser boolean)
 * @param {string?} p.categoriaFinal    a categoria que a linha terá depois da edição
 * @returns {{ ok: true } | { ok: false, status: number, erro: string }}
 */
function validarMarcaTransferencia({ antes, carteira, transferencia, categoriaFinal }) {
  if (typeof transferencia !== 'boolean') {
    return { ok: false, status: 400, erro: 'transferencia tem de ser true ou false.' };
  }
  if (!antes) return { ok: false, status: 404, erro: 'Transação não encontrada neste grupo.' };
  if (!antes.of_tx_id) {
    return { ok: false, status: 409, erro: 'Só lançamentos que vieram do banco podem ser marcados aqui. Para mover dinheiro entre contas que você lança, use "Transferir entre contas".' };
  }
  if (ehCartao(carteira)) {
    return { ok: false, status: 409, erro: 'Em cartão de crédito isto não se aplica: o que entra no cartão já é tratado como pagamento da fatura.' };
  }
  const cats = [antes.categoria, categoriaFinal];
  if (cats.some((c) => ehPagamentoFatura(c) || ehPagamentoFaturaLegado(c))) {
    return { ok: false, status: 409, erro: 'Pagamento de fatura já fica fora dos gastos — contar ele somaria as compras do cartão duas vezes.' };
  }
  if (cats.some((c) => ehAjusteSaldo(c))) {
    return { ok: false, status: 409, erro: 'Ajuste de saldo não conta como gasto nem receita.' };
  }
  if (transferencia === false && String(categoriaFinal || '').trim() === 'Transferências') {
    return { ok: false, status: 400, erro: 'Escolha a categoria deste lançamento (ex.: Financiamento). Com "Transferências" ele continua fora dos gastos e receitas.' };
  }
  return { ok: true };
}

module.exports = { validarMarcaTransferencia };
