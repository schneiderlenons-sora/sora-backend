// =============================================================================
// CONSULTAR A FATURA DE UM CARTÃO pelo WhatsApp.
//
// "fatura do nubank" · "relatório da fatura do mercado pago de outubro" ·
// "extrato do cartão c6" · "quanto está a fatura do inter"
//
// ⚠️ POR QUE EXISTE: até set/2026 dava pra PAGAR a fatura pelo zap, mas não
// pra OLHAR. Quem perguntava caía na regra ampla de `resumo|relatório`, que é
// um catch-all, e recebia o resumo geral do mês — sem o cartão e sem o mês que
// tinha pedido. Foi o relato do cliente: "Relatório da fatura do mercado pago
// credito do mês de outubro" → resumo do mês corrente, por categoria.
//
// ⚠️ O VALOR VEM DE `faturaVista.valorExibido`, a MESMA fonte única do painel
// e do card do cartão — nunca de uma soma local. Somar aqui por conta própria
// é como nascem as divergências "zap × painel" que o projeto já pagou caro
// pra fechar (fatura publicada pelo banco, simulada, parcelas previstas e
// rollover, todos resolvidos lá dentro).
// =============================================================================
const supabase = require('../db/supabase');
const { enviarBotaoLink, enviarTexto } = require('../services/mensageiro');
const { competenciaAtual, cicloPorCompetencia } = require('../services/cicloFatura');
const { statusFatura } = require('../services/faturaRollover');
const { valorExibido } = require('../services/faturaVista');
const { lerPrevistas } = require('../services/parcelasPrevistas');
const { formatar, moedaBaseDoGrupo } = require('../services/moeda');
const { ehPagamentoFatura } = require('../services/categorizar');

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://forsora.com';
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const rotuloComp = (comp) => {
  const [y, m] = String(comp || '').split('-').map(Number);
  return m ? `${MESES[m - 1]}${y !== new Date().getFullYear() ? `/${y}` : ''}` : comp;
};

/**
 * Acha o cartão citado. ⚠️ A 2ª tentativa com " crédito" colado é a MESMA do
 * handler de parcelas, e pelo mesmo motivo: quem tem a conta "Nubank" e o
 * cartão "Nubank Crédito" diz só "fatura do nubank" — o resolvedor canônico
 * devolveria a CONTA (nome exato), e conta de débito não tem fatura.
 */
async function acharCartao(grupoId, termo, cartoes) {
  const { resolverCarteiraReal } = require('./transacoes');
  const n1 = await resolverCarteiraReal(grupoId, termo, cartoes);
  if (n1) return cartoes.find((c) => c.nome === n1) || null;
  const n2 = await resolverCarteiraReal(grupoId, `${termo} crédito`, cartoes);
  if (n2) return cartoes.find((c) => c.nome === n2) || null;
  return null;
}

module.exports = async function handleFaturaCartao(data, ctx) {
  const { phone, grupoId } = ctx;

  const { data: cartoes } = await supabase.from('wallets')
    .select('id, nome, tipo, moeda, limite, dia_fechamento, dia_vencimento, saldo, of_conta_id')
    .eq('grupo_id', grupoId).eq('tipo', 'Crédito').order('nome');

  if (!cartoes?.length) {
    await enviarTexto(phone,
      '💳 Você ainda não tem cartão de crédito cadastrado.\n\n'
      + 'Pra criar: *cartão nubank limite 5000 fecha 5 vence 15*');
    return;
  }

  const cartao = await acharCartao(grupoId, data.termo, cartoes);
  if (!cartao) {
    const lista = cartoes.map((c) => `• ${c.nome}`).join('\n');
    await enviarTexto(phone,
      `🤔 Não achei o cartão *"${data.termo}"*.\n\nSeus cartões:\n${lista}\n\n`
      + 'Ex.: *fatura do ' + cartoes[0].nome.toLowerCase() + '*');
    return;
  }

  // ── Competência: a pedida, ou a atual do cartão ──────────────────────────
  const comp = data.competencia || competenciaAtual(cartao);
  const ciclo = cicloPorCompetencia(cartao, comp);

  // ⚠️ FONTE ÚNICA. Mesma injeção de `parcelasPrevistas` da rota /wallets/faturas
  // e do Oráculo: sem ela, cartão de Open Finance cujo emissor manda parcela
  // sem o marcador "N/M" (Mercado Pago) sai com a fatura MENOR que a do banco.
  const st = await statusFatura(grupoId, cartao, comp);
  const vista = await valorExibido(cartao, comp, st, { parcelasPrevistas: lerPrevistas });

  // ── As compras do ciclo, que é o "relatório" que a pessoa pediu ──────────
  const { data: txs } = await supabase.from('transacoes')
    .select('data, valor, valor_moeda, categoria, observacao, transferencia, tipo')
    .eq('grupo_id', grupoId).ilike('carteira_nome', cartao.nome)
    .gte('data', ciclo.ini).lt('data', ciclo.fimExcl)
    .order('data', { ascending: true });

  // ⚠️ Só COMPRA na lista. Pagamento de fatura é `Gasto` + `transferencia` e
  // apareceria como se fosse gasto novo; crédito/estorno viraria linha
  // negativa no meio das compras. Os dois já estão embutidos no TOTAL que o
  // `valorExibido` devolve — mesma escolha do ranking do DetalhesCartaoModal.
  const compras = (txs || []).filter((t) =>
    t.tipo === 'Gasto' && !t.transferencia && !ehPagamentoFatura(t.categoria));

  const base = await moedaBaseDoGrupo(grupoId);
  const moedaCartao = cartao.moeda || base;
  const fmtC = (v) => formatar(v, moedaCartao);   // cartão fica na moeda DELE

  const dia = (d) => String(d).slice(8, 10) + '/' + String(d).slice(5, 7);
  const nome = (t) => (t.observacao || t.categoria || 'lançamento').slice(0, 28);
  const valorDe = (t) => (t.valor_moeda ?? t.valor) || 0;

  // Lista enxuta: o WhatsApp corta mensagem longa, e fatura com 80 linhas
  // vira parede de texto. As 15 maiores contam a história; o resto é total.
  const LIMITE = 15;
  const ordenadas = [...compras].sort((a, b) => valorDe(b) - valorDe(a));
  const mostrar = ordenadas.slice(0, LIMITE);
  const resto = ordenadas.slice(LIMITE);
  const somaResto = resto.reduce((s, t) => s + valorDe(t), 0);

  const linhas = mostrar
    .sort((a, b) => String(a.data).localeCompare(String(b.data)))
    .map((t) => `${dia(t.data)} · ${nome(t)} — ${fmtC(valorDe(t))}`);

  const periodo = `${dia(ciclo.ini)} a ${dia(ciclo.fim)}`;
  let msg = `💳 *Fatura ${cartao.nome}* · ${rotuloComp(comp)}\n`;
  msg += `_Período: ${periodo}_\n\n`;

  if (!compras.length) {
    msg += 'Nenhuma compra neste ciclo ainda.';
  } else {
    msg += linhas.join('\n');
    if (resto.length) msg += `\n_+${resto.length} lançamento${resto.length > 1 ? 's' : ''} — ${fmtC(somaResto)}_`;
  }

  msg += `\n\n💰 *Total da fatura: ${fmtC(vista.fatura)}*`;
  if (vista.pago > 0) {
    msg += `\n✅ Pago: ${fmtC(vista.pago)}`;
    msg += vista.restante > 0.01
      ? `\n📌 *Falta: ${fmtC(vista.restante)}*`
      : '\n🎉 *Fatura quitada!*';
  }
  msg += vista.fechada ? '\n_Fatura já fechada._' : '\n_Fatura ainda aberta — pode mudar até o fechamento._';

  // ⚠️ A ressalva de parcela PROJETADA é honestidade, não enfeite: a API
  // informa a parcela nominal e o banco arredonda na última, então o total
  // pode sair 1 centavo por compra diferente do app. Melhor dizer do que
  // exibir número redondo que não bate.
  if (String(vista.fonte || '').includes('previstas')) {
    msg += '\n_Inclui parcelas previstas pelo banco (valor aproximado)._';
  }

  await enviarBotaoLink(phone, {
    message: msg,
    label: 'Ver no painel',
    url: `${APP_URL}/cartao-de-credito`,
  });
};
