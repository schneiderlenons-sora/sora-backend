// =============================================================================
// ATUALIZAR O VALOR ATUAL DE UM INVESTIMENTO À MÃO — e só ele.
//
// Pedido de cliente (kalebe, out/2026): "como faço pra adicionar lucro dos
// investimentos". Medido na conta dele: um CDB de R$ 10.500 e uma Petrobrás,
// os dois com `valor_atual` IGUAL ao `valor_aportado` — rendimento zero.
//
// ⚠️ NÃO HAVIA CAMINHO NENHUM. A aba tem "Atualizar cotações" (que só funciona
// com ticker, via Yahoo), Aportar, Resgatar e Excluir. Renda fixa não tem
// cotação pública, então CDB, LCI e Tesouro ficavam parados no valor de
// cadastro para sempre.
//
// ⚠️ E "APORTAR" NÃO SERVE PARA ISSO, embora seja o que a pessoa tenta. O
// aporte soma no `valor_aportado` E no `valor_atual`: o total investido infla
// e a rentabilidade continua 0%. Registraria errado, com cara de certo.
//
// Eval: npm run eval:valor-investimento
// =============================================================================

/**
 * A rentabilidade, na MESMA fórmula do `POST /atualizar-precos`.
 *
 * ⚠️ ELA É COLUNA, NÃO DERIVADA NA TELA. `InvestimentosClient` lê
 * `i.rentabilidade` para o "maior ganho" e a "maior perda" — atualizar o valor
 * sem regravá-la deixaria os dois cards apontando para o ativo errado.
 *
 * ⚠️ Sem aporte não há percentual possível: dividir por zero daria Infinity, e
 * `0` é a resposta honesta (é o que a rota de cotações já faz).
 */
function rentabilidadeDe(valorAtual, valorAportado) {
  const ap = Number(valorAportado) || 0;
  if (!(ap > 0)) return 0;
  return (Number(valorAtual) - ap) / ap;
}

/**
 * O patch de uma atualização manual de valor.
 *
 * @returns {{ erro?: string, motivo?: string, patch?: object }}
 */
function planoDeAtualizarValor(inv, novoValor) {
  if (!inv) return { erro: 'Investimento não encontrado.', motivo: 'nao_encontrado' };

  // ⚠️ O VALOR VEM DA PESSOA: tudo que não for número positivo é recusado.
  // String vazia, null e texto viram NaN; `0` seria "o investimento virou pó",
  // que existe mas não se informa por engano — quem zerou resgata ou exclui.
  const v = Number(novoValor);
  if (!Number.isFinite(v) || v <= 0) {
    return { erro: 'Informe o valor atual do investimento (maior que zero).', motivo: 'valor_invalido' };
  }

  // ⚠️ `valor_aportado` NÃO ENTRA NO PATCH, e é o ponto inteiro deste serviço.
  // Ele é quanto a pessoa colocou do bolso; mexer nele apagaria o lucro em vez
  // de registrá-lo, e estragaria a rentabilidade da carteira toda.
  const patch = {
    valor_atual:        v,
    rentabilidade:      rentabilidadeDe(v, inv.valor_aportado),
    ultima_atualizacao: new Date().toISOString(),
  };

  // ⚠️ Ativo com TICKER é regravado pelo `POST /atualizar-precos` na próxima
  // passada — o valor digitado duraria até ali. Não é recusa: pode ser
  // exatamente o que a pessoa quer num fim de semana, com a bolsa fechada. Mas
  // a tela precisa dizer, senão o número "volta sozinho" e parece defeito.
  const temporario = !!(inv.ticker && String(inv.ticker).trim());

  return { patch, temporario };
}

module.exports = { planoDeAtualizarValor, rentabilidadeDe };
