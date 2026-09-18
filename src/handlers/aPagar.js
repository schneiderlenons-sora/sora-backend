// =============================================================================
// "O que eu tenho pra pagar essa semana?" — WhatsApp.
//
// A regra (quais contas, quais datas, o que já está resolvido) mora em
// services/aPagarPeriodo.js e é travada em `eval:a-pagar`. Aqui só se busca,
// converte moeda quando preciso e envia.
// =============================================================================
const { enviarBotaoLink, enviarTexto } = require('../services/mensageiro');
const { janelaAPagar, montarItens, formatarAPagar, coletar, contarAtrasadas } = require('../services/aPagarPeriodo');
const { moedaBaseDoGrupo, formatar, normalizarMoeda, taxasParaBase, paraBase } = require('../services/moeda');

// Mesma origem do botão do resumo (handlers/transacoes.js).
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://forsora.com').replace(/\/$/, '');

module.exports = async function handleAPagar(data, ctx) {
  const { phone, grupoId } = ctx;
  if (!grupoId) {
    await enviarTexto(phone, '✨ Não encontrei contas cadastradas pra você ainda.');
    return;
  }

  const janela = janelaAPagar(data.periodo);
  const dados = await coletar(grupoId, janela);
  const itens = montarItens(dados, janela);

  const base = await moedaBaseDoGrupo(grupoId);
  // Câmbio só quando há fatura de cartão em outra moeda — sem isso, nenhuma
  // ida de rede e o total é a soma de sempre.
  const moedasFora = itens.filter((i) => i.moeda && normalizarMoeda(i.moeda) !== base).map((i) => i.moeda);
  let tabela = {};
  if (moedasFora.length) {
    try { tabela = await taxasParaBase(moedasFora, base); } catch { tabela = {}; }
  }

  const texto = formatarAPagar(itens, janela, {
    fmt: (v) => formatar(v, base),
    fmtMoeda: (v, m) => formatar(v, normalizarMoeda(m) === base ? base : m),
    paraBase: (v, m) => (normalizarMoeda(m) === base ? v : paraBase(v, m, base, tabela)),
    atrasadas: contarAtrasadas(dados.dividas),
  });

  // Botão pro Extrato Futuro (mesma ideia do resumo: botão em vez de link cru).
  await enviarBotaoLink(phone, {
    message: texto,
    label: 'Ver no painel',
    url: `${APP_URL}/previstos?aba=extrato`,
  });
};
