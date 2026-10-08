// =============================================================================
// ALTERAR UMA TRANSAÇÃO — a aritmética do saldo, em um lugar só.
//
// Pedido de cliente (Fábio, 05/10/2026): *"a possibilidade de ALTERAR o
// lançamento, e não só a de exclusão"*. Pelo WhatsApp só dava pra apagar e
// lançar de novo — o que perde o id, a data original e qualquer vínculo.
//
// ⚠️ ESTA REGRA JÁ EXISTIA, DENTRO DO `PUT /api/transacoes/:id`. Escrever uma
// segunda cópia pro WhatsApp seria repetir exatamente o erro que este projeto
// já pagou caro várias vezes (5 cópias do vencimento de dívida, 3 do
// "resolvida no mês", 7 do valor da fatura). O PUT passou a chamar daqui, e o
// `eval:alterar-transacao` compara os dois contra a versão antiga pra provar
// regressão zero.
//
// O serviço é PURO: recebe o estado antes/depois e devolve QUAIS carteiras
// mexer e em quanto. Quem lê e grava é o chamador — é o que o torna testável
// sem banco.
// =============================================================================

const { ehPagamentoFatura } = require('./categorizar');

/** Nome de carteira normalizado (o resto do projeto casa por `ilike`). */
function normNome(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * A linha tem débito PRÓPRIO e por isso não mexe no saldo por aqui?
 *
 * ⚠️ Transferência e pagamento de fatura já movem dinheiro pelo caminho
 * deles. Contar de novo aqui tiraria o valor DUAS vezes — é o mesmo
 * `especial` do PUT e do `services/quitacao.js`.
 */
function especial(t) {
  if (!t) return true;
  return t.transferencia === true
      || ehPagamentoFatura(t.categoria)
      || t.categoria === 'Transferências';
}

/**
 * O valor NATIVO da linha — na moeda da CONTA, não na base do grupo.
 *
 * ⚠️ `wallets.saldo` está na moeda da conta e `transacoes.valor` na base do
 * grupo (migration 168). Numa conta em coroa, mexer no saldo com o valor em
 * real erra ~45%. Linha na base não tem `valor_moeda` e cai no `valor`.
 */
function valorNativo(t) {
  return Number(t?.valor_moeda ?? t?.valor) || 0;
}

/**
 * Quanto esta linha pesa no saldo da conta dela, hoje.
 *
 * ⚠️ PENDENTE PESA ZERO. Gasto não pago ainda não saiu da conta — por isso
 * mudar o valor de um pendente não pode mexer em saldo nenhum.
 */
function efeitoNoSaldo(t) {
  if (!t || !t.pago) return 0;
  return (t.tipo === 'Gasto' ? -1 : 1) * valorNativo(t);
}

/**
 * O que mexer no saldo pra sair de `antes` e chegar em `depois`.
 *
 * @returns {{ ajustes: Array<{nome: string, delta: number}>, motivo: string|null }}
 *   `ajustes` já vem SEM os deltas zerados. `motivo` explica por que não há
 *   ajuste, quando for o caso (serve pro log e pro diagnóstico).
 */
function ajustesDeSaldo(antes, depois) {
  // ⚠️ OS DOIS LADOS TÊM DE SER COMUNS. Se a linha ERA transferência e deixou
  // de ser (ou o contrário), o saldo dela nunca passou por aqui — aplicar a
  // diferença inventaria dinheiro. Mesma guarda do PUT.
  if (especial(antes) || especial(depois)) {
    return { ajustes: [], motivo: 'transferencia_ou_fatura' };
  }

  const mesmaConta = normNome(antes.carteira_nome) === normNome(depois.carteira_nome);

  const brutos = mesmaConta
    ? [{ nome: depois.carteira_nome, delta: efeitoNoSaldo(depois) - efeitoNoSaldo(antes) }]
    : [
        // Tira o efeito da conta ANTIGA e aplica na NOVA. Em duas linhas de
        // propósito: a antiga pode ser do banco (e ser pulada) sem que isso
        // impeça a nova de receber o valor.
        { nome: antes.carteira_nome,  delta: -efeitoNoSaldo(antes) },
        { nome: depois.carteira_nome, delta:  efeitoNoSaldo(depois) },
      ];

  const ajustes = brutos.filter((a) => a.nome && a.delta);
  return { ajustes, motivo: ajustes.length ? null : 'sem_diferenca' };
}

// ── O QUE DÁ PRA ALTERAR PELO WHATSAPP ──────────────────────────────────────
//
// ⚠️ LISTA FECHADA, e curta de propósito. O WhatsApp não tem formulário: cada
// campo aqui precisa de uma frase que a pessoa diga naturalmente E de um jeito
// de confirmar o que mudou. Campo que ninguém pede vira superfície de erro.
const CAMPOS = ['valor', 'categoria', 'descricao', 'conta', 'data', 'tipo'];

/** Rótulo humano do campo, pro texto de confirmação. */
const ROTULO = {
  valor: 'Valor',
  categoria: 'Categoria',
  descricao: 'Descrição',
  conta: 'Conta',
  data: 'Data',
  tipo: 'Tipo',
};

/**
 * Monta o patch da transação a partir das mudanças pedidas.
 *
 * ⚠️ `valor_moeda` ANDA JUNTO com o valor. A pessoa fala o valor na moeda da
 * CONTA (é o que ela vê), então em conta estrangeira os dois mudam; em conta
 * na base, `valor_moeda` é null e fica null.
 *
 * @param {Object} tx        a linha como está hoje
 * @param {Object} mudancas  { valor?, categoria?, descricao?, conta?, data?, tipo? }
 * @returns {{ patch: Object, depois: Object, alterados: string[] }}
 */
function planoDeAlteracao(tx, mudancas) {
  const patch = {};
  const alterados = [];

  const mudou = (campo, valorNovo, valorAtual) => {
    if (valorNovo === undefined || valorNovo === null) return false;
    if (String(valorNovo) === String(valorAtual ?? '')) return false;
    alterados.push(campo);
    return true;
  };

  if (mudou('valor', mudancas.valor, valorNativo(tx))) {
    const v = Number(mudancas.valor);
    // Em conta estrangeira o valor falado é o NATIVO; o da base acompanha pela
    // taxa que já está congelada na linha (nunca busca câmbio novo: a taxa do
    // dia da compra é a que vale).
    if (tx.moeda && tx.valor_moeda != null) {
      const taxa = Number(tx.valor) / Number(tx.valor_moeda || 1) || 1;
      patch.valor_moeda = v;
      patch.valor = Number((v * taxa).toFixed(2));
    } else {
      patch.valor = v;
    }
  }

  if (mudou('categoria', mudancas.categoria, tx.categoria))  patch.categoria = mudancas.categoria;
  if (mudou('descricao', mudancas.descricao, tx.observacao)) patch.observacao = mudancas.descricao;
  if (mudou('conta', mudancas.conta, tx.carteira_nome))      patch.carteira_nome = mudancas.conta;
  if (mudou('data', mudancas.data, String(tx.data || '').slice(0, 10))) patch.data = mudancas.data;
  if (mudou('tipo', mudancas.tipo, tx.tipo))                 patch.tipo = mudancas.tipo;

  const depois = { ...tx, ...patch };
  return { patch, depois, alterados };
}

module.exports = {
  normNome,
  especial,
  valorNativo,
  efeitoNoSaldo,
  ajustesDeSaldo,
  planoDeAlteracao,
  CAMPOS,
  ROTULO,
};
