// =============================================================================
// DESFAZER UM PAGAMENTO DE FATURA.
//
// POR QUE EXISTE (01/10/2026). Pergunta de cliente: "paguei a fatura por
// engano numa conta manual, tem como reverter?". Não tinha — e o caminho que
// ele tentaria sozinho deixava a conta PIOR do que antes.
//
// ⚠️ PAGAR FATURA GRAVA EM DOIS LUGARES, e desfazer pela metade é o estrago:
//   1. uma transação `Fatura <cartão>` que DEBITA o saldo da conta;
//   2. uma linha em `pagamentos_fatura`, de onde sai `restante = fatura − pago`.
//
// Apagando só o lançamento pela aba Transações (o caminho intuitivo), o saldo
// volta e a linha de `pagamentos_fatura` SOBREVIVE — a chave estrangeira é
// `on delete set null`. Resultado: o dinheiro volta para a conta e a fatura
// continua marcada como paga, sem nenhuma tela que mostre esse registro.
// Medido na base: 322 pagamentos, 55 em cartão manual, 14 já sem vínculo.
//
// Aqui a decisão de PODER desfazer fica isolada e testada. A execução (apagar
// linha, apagar transação, devolver saldo) vive na rota, que é quem tem banco.
// =============================================================================

/** Rollover já materializado: a sobra virou lançamento na fatura seguinte. */
const ROLLOVER_FEITO = 'rolado';

/**
 * Este pagamento pode ser desfeito?
 *
 * @param pagamento `pagamentos_fatura` (valor, competencia, transacao_id)
 * @param cartao    `wallets` do cartão (of_conta_id decide se é do banco)
 * @param rollover  a linha de `fatura_rollover` daquela competência, se houver
 * @returns { ok: boolean, motivo: string|null, codigo: string|null }
 */
function podeDesfazer({ pagamento, cartao, rollover } = {}) {
  if (!pagamento || !pagamento.id) {
    return { ok: false, codigo: 'nao_encontrado', motivo: 'Pagamento não encontrado.' };
  }

  // ⚠️ CARTÃO DO BANCO NÃO SE DESFAZ. Ali o pagamento não foi digitado: veio do
  // extrato pelo Open Finance (`registrarPagamentosDoOF`). Apagar aqui seria
  // enxugar gelo — o próximo sync o traz de volta — e ainda apagaria uma
  // transação que o banco de fato reportou.
  if (cartao && cartao.of_conta_id) {
    return {
      ok: false,
      codigo: 'cartao_do_banco',
      motivo: 'Este cartão é sincronizado com o banco: o pagamento veio do extrato e voltaria na próxima atualização. Para corrigir, ajuste direto no banco.',
    };
  }

  // ⚠️ ROLLOVER JÁ MATERIALIZADO: a sobra daquela fatura virou um lançamento
  // "Fatura anterior" na competência seguinte. Desfazer o pagamento sem
  // desfazer o rollover deixaria DUAS faturas erradas — a de origem voltaria a
  // dever o total e a seguinte continuaria cobrando a sobra. Recusar com o
  // motivo escrito é melhor que desfazer pela metade.
  if (rollover && rollover.status === ROLLOVER_FEITO) {
    return {
      ok: false,
      codigo: 'rollover_feito',
      motivo: 'O que sobrou desta fatura já foi lançado na fatura seguinte. Desfazer agora deixaria as duas erradas — fale com a gente para acertar.',
    };
  }

  return { ok: true, codigo: null, motivo: null };
}

/**
 * O que a rota precisa executar, já decidido.
 *
 * ⚠️ `devolverSaldo` é FALSE em pagamento externo (quem pagou foi outra
 * pessoa, nenhuma conta do usuário foi debitada) e em conta que não existe
 * mais. Devolver saldo a uma conta que não pagou criaria dinheiro.
 */
function planoDeDesfazer({ pagamento, transacao, carteira } = {}) {
  const valor = Number(pagamento?.valor) || 0;

  // Sem transação vinculada não há lançamento a apagar nem saldo a devolver —
  // resta limpar o registro, que é o que faz a fatura voltar a aparecer aberta.
  const temTransacao = !!(transacao && transacao.id);

  // ⚠️ O VALOR DEVOLVIDO É O DA TRANSAÇÃO, não o do registro de pagamento.
  // Num pagamento dividido entre duas contas há UMA linha em
  // `pagamentos_fatura` com o total e DUAS transações; devolver o total à conta
  // de uma delas inventaria dinheiro nela.
  const valorTransacao = temTransacao ? (Number(transacao.valor_moeda ?? transacao.valor) || 0) : 0;

  // ⚠️ Carteira de Open Finance nunca tem saldo mexido à mão — é a regra de
  // ouro do projeto. `saldoCarteira.moverSaldo` também recusa; aqui a decisão
  // fica explícita pra tela poder avisar.
  const contaDoBanco = !!(carteira && carteira.of_conta_id);
  const devolverSaldo = temTransacao && !!carteira && !contaDoBanco && valorTransacao > 0;

  return {
    apagarTransacao: temTransacao,
    devolverSaldo,
    valorDevolvido: devolverSaldo ? valorTransacao : 0,
    contaDoBanco,
    valorPagamento: valor,
  };
}

module.exports = { podeDesfazer, planoDeDesfazer, ROLLOVER_FEITO };
