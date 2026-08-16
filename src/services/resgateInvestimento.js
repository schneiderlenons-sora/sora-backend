// =============================================================================
// Aritmética do RESGATE de investimento (pura, sem banco — testada em eval).
//
// Resgatar = tirar dinheiro de uma aplicação. O que torna isso não-trivial é
// que o investimento guarda DOIS valores: quanto foi APORTADO e quanto vale
// HOJE. Mexer só no valor atual destrói a rentabilidade.
//
// ⚠️ O RESGATE É PROPORCIONAL. Quem aportou R$ 1.000, o investimento virou
// R$ 1.200 e resgata R$ 600 (metade do valor atual), levou embora metade da
// aplicação — então o aportado também cai pela metade (R$ 500). Assim a
// rentabilidade continua +20% depois do resgate, que é a verdade.
//
// Se o aportado NÃO caísse junto, sobraria "aportado 1.000 / atual 600" e o
// painel mostraria −40% de prejuízo num investimento que só teve saque. Esse é
// o erro que este arquivo existe pra impedir.
// =============================================================================

const cent = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Calcula o estado do investimento DEPOIS de um resgate.
 *
 * @param {object} inv    { valor_atual, valor_aportado, quantidade }
 * @param {number} valor  quanto está sendo resgatado (em R$)
 * @returns {{ ok: true, patch: object, zerou: boolean } | { ok: false, erro: string }}
 */
function aplicarResgate(inv, valor) {
  const v = Number(valor);
  if (!Number.isFinite(v) || v <= 0) {
    return { ok: false, erro: 'Informe um valor de resgate maior que zero.' };
  }

  const atual = Number(inv?.valor_atual) || 0;
  if (atual <= 0) {
    return { ok: false, erro: 'Este investimento está zerado — não há o que resgatar.' };
  }

  // ⚠️ Tolerância de 1 centavo: o usuário que quer sacar TUDO digita o valor
  // que está na tela, e esse número já passou por arredondamento. Sem a
  // folga, "resgatar tudo" falharia por diferença invisível.
  if (v > cent(atual) + 0.01) {
    return { ok: false, erro: `Você só tem ${atual.toFixed(2)} nesse investimento.` };
  }

  const resgatado = Math.min(v, atual);          // nunca tira mais do que existe
  const proporcao = resgatado / atual;           // 0..1
  const restante  = 1 - proporcao;
  const zerou     = cent(atual - resgatado) <= 0;

  const aportado = Number(inv?.valor_aportado);
  const qtd      = Number(inv?.quantidade);

  const patch = {
    valor_atual: zerou ? 0 : cent(atual - resgatado),
  };
  // `valor_aportado` e `quantidade` só entram no patch quando EXISTEM. Gravar
  // 0 num campo que era null inventaria dado que o usuário nunca informou.
  if (Number.isFinite(aportado)) patch.valor_aportado = zerou ? 0 : cent(aportado * restante);
  if (Number.isFinite(qtd))      patch.quantidade     = zerou ? 0 : Math.round(qtd * restante * 1e8) / 1e8;

  return { ok: true, patch, zerou, resgatado: cent(resgatado) };
}

module.exports = { aplicarResgate };
