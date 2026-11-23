// =============================================================================
// "Quanto eu tenho a receber ainda este mês?" — WhatsApp.
//
// A regra (quais entradas, quais datas, o que já foi recebido) mora em
// services/aReceberPeriodo.js e é travada em `eval:a-receber`. Aqui só se
// busca, formata na moeda do grupo e envia.
// =============================================================================
const { enviarBotaoLink, enviarTexto } = require('../services/mensageiro');
const { janelaAReceber, montarItensReceber, formatarAReceber, coletar } = require('../services/aReceberPeriodo');
const { moedaBaseDoGrupo, formatar } = require('../services/moeda');

// Mesma origem do botão do "a pagar".
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://forsora.com').replace(/\/$/, '');

module.exports = async function handleAReceber(data, ctx) {
  const { phone, grupoId } = ctx;
  if (!grupoId) {
    await enviarTexto(phone, '✨ Não encontrei receitas cadastradas pra você ainda.');
    return;
  }

  const janela = janelaAReceber(data.periodo);
  const dados = await coletar(grupoId, janela);
  const itens = montarItensReceber(dados, janela);
  const base = await moedaBaseDoGrupo(grupoId);
  const texto = formatarAReceber(itens, janela, { fmt: (v) => formatar(v, base) });

  await enviarBotaoLink(phone, {
    message: texto,
    label: 'Ver no painel',
    url: `${APP_URL}/previstos?aba=extrato`,
  });
};
