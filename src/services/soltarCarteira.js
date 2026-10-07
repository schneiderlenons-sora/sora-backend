// =============================================================================
// SOLTAR A CARTEIRA DO BANCO — devolver uma conta órfã ao uso manual.
//
// ⚠️ O LIMBO QUE ISTO RESOLVE. Quando a conexão de Open Finance acaba — porque
// a pessoa desconectou, porque o consentimento expirou, ou porque nós cortamos
// —, a carteira CONTINUA com `of_conta_id`. E `services/saldoCarteira.js` pula
// qualquer carteira que o tenha (regra de ouro: saldo de conta do banco nunca
// é mexido à mão). Resultado:
//
//   · o sync não roda mais       → o saldo congela no último valor recebido;
//   · o lançamento manual não o move → a pessoa não consegue corrigir;
//   · e não há botão nenhum pra sair disso.
//
// A única saída era criar OUTRA conta com o mesmo nome — o que PARTE o
// histórico em dois. Isso já aconteceu na base: "BTG Banking" com 321
// transações convivendo com "BTG Banking (OF)" com 540.
//
// Medido em 07/10/2026: 16 carteiras já nesse estado, em 5 grupos, com
// R$ 18.103,97 congelados e 2.370 transações presas.
//
// Soltar preserva tudo — nome, histórico, saldo de partida — e só devolve o
// controle: a conta volta a aceitar "Ajustar" e a ter o saldo movido pelos
// lançamentos, como qualquer conta manual.
//
// Eval: npm run eval:soltar-carteira
// =============================================================================

/**
 * Esta carteira pode ser solta do banco?
 *
 * @param carteira  linha de `wallets`
 * @param consentsVivos  Set com os `external_id` das conexões VIVAS do grupo,
 *   ou `null` quando não foi possível lê-las.
 * @returns {{ pode: boolean, erro?: string, motivo?: string }}
 */
function podeSoltar(carteira, consentsVivos) {
  if (!carteira) {
    return { pode: false, erro: 'Conta não encontrada.', motivo: 'nao_encontrada' };
  }
  if (!carteira.of_conta_id) {
    return {
      pode: false,
      erro: 'Esta conta não vem do Open Finance — ela já é manual.',
      motivo: 'ja_manual',
    };
  }

  // ⚠️ SEM A LISTA, NÃO SOLTA. Falha ao ler as conexões não pode virar
  // "então está órfã": soltar uma carteira com conexão VIVA faria o sync
  // recriar outra no próximo passe, e o histórico se partiria em duas —
  // exatamente o estrago que esta função existe pra desfazer.
  if (!(consentsVivos instanceof Set)) {
    return {
      pode: false,
      erro: 'Não consegui conferir suas conexões agora. Tente de novo em instantes.',
      motivo: 'conexoes_indisponiveis',
    };
  }

  // Carteira legada, sem consentimento gravado: não dá pra provar que está
  // órfã, mas também não há conexão a que ela pertença. Soltar é seguro —
  // nenhum sync a reivindica.
  const consent = carteira.of_consent_id ? String(carteira.of_consent_id) : null;
  if (consent && consentsVivos.has(consent)) {
    return {
      pode: false,
      erro: 'Esta conta ainda está conectada ao banco. Desconecte em Open Finance antes de usá-la manualmente.',
      motivo: 'conexao_viva',
    };
  }

  return { pode: true };
}

/**
 * O patch que devolve a carteira ao modo manual.
 *
 * ⚠️ SÓ OS VÍNCULOS SAEM. Nome, tipo, saldo, moeda e tudo mais ficam como
 * estão: o saldo que o banco deixou é o ponto de partida honesto, e as
 * transações casam por `carteira_nome` — mexer no nome aqui transformaria 2.370
 * lançamentos em conta-fantasma.
 */
function planoDeSoltar() {
  return { of_conta_id: null, of_consent_id: null };
}

module.exports = { podeSoltar, planoDeSoltar };
