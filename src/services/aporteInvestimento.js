// =============================================================================
// Aritmética do APORTE de investimento (pura, sem banco — testada em eval).
//
// Espelha `resgateInvestimento.js`, que é o caminho inverso. Os dois precisam
// ser simétricos: o resgate JÁ reduzia a quantidade proporcionalmente, e o
// aporte não somava nada nela — era esse desencontro que produzia o relato.
//
// ⚠️ O APORTE NÃO MEXIA NA QUANTIDADE, E ISSO APAGAVA O DINHEIRO DA TELA.
// Relato: *"tem a opção aporte, mas somente com o valor, e com isso a
// quantidade de cota não tem como aumentar"*. O efeito não é cosmético: em
// ativo com ticker, `POST /atualizar-precos` recalcula
// `valor_atual = cotação × quantidade`. Com a quantidade velha, a próxima
// atualização de preço **sobrescreve o aporte** — o `valor_aportado` sobe, o
// `valor_atual` volta pro tamanho da posição antiga, e a tela passa a mostrar
// PREJUÍZO numa compra que só aumentou a posição.
//
// Medido na conta do cliente do relato (RADL3.SA): 5 cotas a R$ 19,53 =
// R$ 97,65, mais um aporte de R$ 19,63 (1 cota) → aportado R$ 117,28 com
// quantidade ainda em 5. O refresh devolveu valor atual R$ 98,30 (5 × 19,66) e
// a tela passou a acusar −16% de prejuízo que não existe.
//
// ⚠️ A QUANTIDADE É OPCIONAL, de propósito. Metade da base é renda fixa
// (CDB, LCI, Tesouro), onde "cota" não significa nada e o aporte é só dinheiro
// entrando. Sem quantidade informada, o resultado é idêntico ao de antes —
// nenhuma linha existente muda de comportamento.
// =============================================================================

/** Dinheiro: 2 casas. */
const cent = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Quantidade e preço unitário: 8 casas.
 *
 * ⚠️ NÃO usar `cent` no preço unitário. Tem cripto e cota de fundo valendo
 * frações de centavo — a base tem um com `preco_unitario = 0,0101`, que
 * arredondado pra 2 casas viraria 0,01 e erraria a posição em 1%.
 */
const oitavo = (n) => Math.round((Number(n) || 0) * 1e8) / 1e8;

/**
 * Calcula o estado do investimento DEPOIS de um aporte.
 *
 * @param {object} inv  { valor_atual, valor_aportado, quantidade }
 * @param {object} mov  { valor, quantidade? } — `quantidade` só em renda variável
 * @returns {{ ok: true, patch: object, aportado: number, precoMedio: number|null }
 *          | { ok: false, erro: string }}
 */
function aplicarAporte(inv, mov = {}) {
  const v = Number(mov.valor);
  if (!Number.isFinite(v) || v <= 0) {
    return { ok: false, erro: 'Informe um valor de aporte maior que zero.' };
  }

  // "Informou quantidade?" precisa distinguir AUSÊNCIA de zero: `undefined`,
  // `null` e string vazia são "não informou" (renda fixa manda assim); um zero
  // de verdade é erro de digitação e merece recusa em vez de virar no-op.
  const bruta = mov.quantidade;
  const informouQtd = bruta !== undefined && bruta !== null && String(bruta).trim() !== '';

  let q = 0;
  if (informouQtd) {
    q = Number(bruta);
    if (!Number.isFinite(q) || q <= 0) {
      return { ok: false, erro: 'A quantidade de cotas precisa ser maior que zero.' };
    }
  }

  const aportadoAntes = Number(inv?.valor_aportado) || 0;
  const atualAntes    = Number(inv?.valor_atual)    || 0;
  const qtdAntes      = Number(inv?.quantidade);

  const patch = {
    valor_aportado: cent(aportadoAntes + v),
    // ⚠️ O valor atual sobe pelo DINHEIRO QUE ENTROU, não por cotação. Em ativo
    // com ticker isto é provisório: o próximo `atualizar-precos` recalcula
    // `cotação × quantidade` — e agora acerta, porque a quantidade subiu junto.
    // Buscar cotação aqui colocaria uma chamada de rede (que falha) no meio de
    // uma escrita de dinheiro.
    valor_atual: cent(atualAntes + v),
  };

  let precoMedio = null;
  if (informouQtd) {
    const qtdNova = oitavo((Number.isFinite(qtdAntes) ? qtdAntes : 0) + q);
    patch.quantidade = qtdNova;
    if (qtdNova > 0) {
      // Preço MÉDIO, que é exatamente o que a tela já exibe como "PM"
      // (`aportado ÷ quantidade` no InvestimentosClient). Gravar o preço da
      // última compra faria o campo brigar com o número mostrado ao lado.
      precoMedio = oitavo(patch.valor_aportado / qtdNova);
      patch.preco_unitario = precoMedio;
    }
  }

  return { ok: true, patch, aportado: cent(v), precoMedio };
}

/**
 * A posição vem do Open Finance? Então lançamento manual é recusado.
 *
 * ⚠️ REGRA DE OURO: posição sincronizada é do BANCO, não nossa.
 * `upsertInvestimento` (polpCelcoinSync) reescreve quantidade, preço unitário,
 * aportado e valor atual a CADA sync. Um aporte ou resgate manual ali não
 * sobrevive à próxima sincronização — e, até ela rodar, faz o painel divergir
 * do app do banco sem nada na tela explicando por quê. É a mesma família do
 * "carteira com `of_conta_id` nunca tem saldo ajustado".
 *
 * Medido em 16/09/2026: 632 dos 700 investimentos da base vêm do OF, e um deles
 * JÁ tinha recebido aporte manual de R$ 198,02 que o sync apagou em silêncio.
 * Recusar com motivo é melhor do que aceitar e desfazer depois.
 *
 * @returns {null} quando pode seguir · {{erro, motivo}} quando é do banco
 */
function recusaSeDoBanco(inv, acao = 'lançamento') {
  if (!inv?.of_id && inv?.origem !== 'of') return null;
  return {
    erro: `Este investimento vem do seu banco pelo Open Finance, então a posição é atualizada automaticamente — um ${acao} manual aqui seria desfeito na próxima sincronização.`,
    motivo: 'investimento_do_open_finance',
  };
}

module.exports = { aplicarAporte, recusaSeDoBanco };
