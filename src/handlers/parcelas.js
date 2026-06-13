const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/zapi');
const { criarPendente } = require('../services/pendentes');
const { oferecerDesconto } = require('../services/descontoConta');

const gerarId = () => Math.random().toString(36).substring(2, 8).toUpperCase();

module.exports = async function handleParcelas(data, ctx) {
  const { phone, grupoId, user } = ctx;

  // ── PAGAR FATURA DO CARTÃO (manual): "pagar fatura nubank" ──────
  if (data.acao === 'pagar_fatura') {
    const termo = (data.termo || '').trim();
    const { data: cartoes } = await supabase.from('wallets')
      .select('id, nome').eq('grupo_id', grupoId).eq('tipo', 'Crédito')
      .ilike('nome', `%${termo}%`).order('created_at', { ascending: true });
    if (!cartoes?.length) {
      await enviarTexto(phone, termo
        ? `❌ Não encontrei cartão com *"${termo}"*. Veja os seus: 🌐 forsora.com/cartao-de-credito`
        : `💳 Você ainda não tem cartão de crédito cadastrado.\nCrie um: *cartão nubank limite 5000 fecha 5 vence 15*`);
      return;
    }
    if (cartoes.length > 1) {
      const lista = cartoes.map(c => `• ${c.nome}`).join('\n');
      await enviarTexto(phone, termo
        ? `🤔 Mais de um cartão com *"${termo}"*:\n${lista}\n\nSeja mais específico.`
        : `💳 Você tem mais de um cartão. Qual fatura quer pagar?\n${lista}\n\nEx.: *pagar fatura ${cartoes[0].nome.toLowerCase()}*`);
      return;
    }
    const cartao = cartoes[0];

    // Fatura do mês = soma dos gastos do cartão no mês atual
    const hoje = new Date();
    const ini = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-01`;
    const prox = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 1).toISOString().slice(0, 10);
    const { data: txs } = await supabase.from('transacoes')
      .select('valor').eq('grupo_id', grupoId).eq('tipo', 'Gasto')
      .ilike('carteira_nome', cartao.nome).gte('data', ini).lt('data', prox);
    const fatura = (txs || []).reduce((s, t) => s + (t.valor || 0), 0);

    if (fatura <= 0) {
      await enviarTexto(phone, `🎉 A fatura do *${cartao.nome}* está zerada este mês. Nada a pagar!`);
      return;
    }

    await oferecerDesconto({
      user, phone, grupoId, valor: fatura,
      categoria: 'Fatura cartão', observacao: `Fatura ${cartao.nome}`,
      intro: `💳 *Fatura ${cartao.nome}: R$ ${fatura.toFixed(2)}*\nDe qual conta você quer pagar?`,
    });
    return;
  }

  // ── DEFINIR DIA DE FECHAMENTO DA FATURA ─────────────────────────
  if (data.acao === 'set_fatura_dia') {
    await supabase.from('users')
      .update({ dia_fechamento_fatura: data.dia })
      .eq('phone', phone);
    await enviarTexto(phone, `📅 Dia de fechamento da fatura definido para o dia *${data.dia}* de cada mês.`);
    return;
  }

  // ── COMPRA PARCELADA ────────────────────────────────────────────
  if (data.acao === 'compra_parcelada') {
    const { descricao, numParcelas, valorParcela, valorTotal, categoria } = data;

    // Normaliza nome do cartão de crédito
    let carteiraNome = data.carteira.trim();
    if (!carteiraNome.toLowerCase().includes('crédito') &&
        !carteiraNome.toLowerCase().includes('credito')) {
      await enviarTexto(phone, '⚠️ Compras parceladas só são permitidas em contas de *crédito*.\nEx: "comprei fone no nubank crédito em 3x de 150"');
      return;
    }

    // Busca o cartão de crédito
    const { data: wallet } = await supabase.from('wallets')
      .select('id, nome, saldo')
      .eq('grupo_id', grupoId)
      .ilike('nome', `%${carteiraNome}%`)
      .single();

    if (!wallet) {
      await enviarTexto(phone, `❌ Cartão *${carteiraNome}* não encontrado.\nCrie primeiro com: "${carteiraNome.toLowerCase()} 0"`);
      return;
    }
    // Gera N transações futuras (uma por fatura/mês). Cada parcela é um Gasto
    // não-pago no cartão, com data no mês da respectiva fatura. Assim o painel
    // (que lê transações) reflete o limite comprometido, mostra faturas futuras
    // e permite antecipar. A 1ª parcela cai na FATURA ATUAL (mês corrente) —
    // a compra de hoje entra na fatura aberta. As seguintes nos meses seguintes.
    const hoje = new Date();
    const linhas = [];
    for (let i = 0; i < numParcelas; i++) {
      const d = i === 0
        ? hoje  // 1ª parcela na data de hoje (fatura atual)
        : new Date(hoje.getFullYear(), hoje.getMonth() + i, Math.min(hoje.getDate(), 28));
      linhas.push({
        id_curto:      gerarId(),
        grupo_id:      grupoId,
        tipo:          'Gasto',
        categoria:     categoria || 'Outros',
        valor:         valorParcela,
        observacao:    `${descricao} (${i + 1}/${numParcelas})`,
        carteira_nome: wallet.nome,
        pago:          false,
        data:          d.toISOString(),
      });
    }
    await supabase.from('transacoes').insert(linhas);

    const ultimaData = new Date(hoje.getFullYear(), hoje.getMonth() + (numParcelas - 1), Math.min(hoje.getDate(), 28));
    await enviarTexto(phone,
      `✅ *Compra parcelada registrada!*\n\n` +
      `📦 ${descricao}\n` +
      `💳 Cartão: ${wallet.nome}\n` +
      `🏷️ Categoria: ${categoria || 'Outros'}\n` +
      `💵 Total: R$ ${valorTotal.toFixed(2)} em ${numParcelas}x de R$ ${valorParcela.toFixed(2)}\n` +
      `📅 1ª parcela na fatura atual · última em ${ultimaData.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}\n\n` +
      `As ${numParcelas} parcelas já aparecem nas faturas do painel. Você pode antecipar por lá.`
    );
    return;
  }

  // ── ANTECIPAR PARCELA(S) ────────────────────────────────────────
  // Marca como paga(s) a(s) parcela(s) em aberto (transações não-pagas)
  // cujo nome casa com o termo. "antecipar parcela X" = a próxima;
  // "quitar parcelas X" = todas.
  if (data.acao === 'antecipar_parcela') {
    const termo = (data.termo || '').trim();
    if (!termo) {
      await enviarTexto(phone, '❓ Qual compra? Ex: "antecipar parcela do fone" ou "quitar parcelas da tv".');
      return;
    }

    const { data: parcelas } = await supabase.from('transacoes')
      .select('*')
      .eq('grupo_id', grupoId)
      .eq('tipo', 'Gasto')
      .eq('pago', false)
      .ilike('observacao', `%${termo}%`)
      .order('data', { ascending: true });

    if (!parcelas?.length) {
      await enviarTexto(phone, `❌ Não encontrei parcelas em aberto de *"${termo}"*.\nVeja suas faturas no painel: forsora.com/cartao-de-credito`);
      return;
    }

    const alvo = data.todas ? parcelas : [parcelas[0]];
    const totalPago = alvo.reduce((s, t) => s + (t.valor || 0), 0);

    // Pagar fatura debita de uma conta — pergunta de qual (igual ao painel).
    const { data: contas } = await supabase.from('wallets')
      .select('id, nome, saldo, tipo, arquivada')
      .eq('grupo_id', grupoId)
      .neq('tipo', 'Crédito')
      .order('created_at', { ascending: true });
    const contasAtivas = (contas || []).filter(c => !c.arquivada);

    if (contasAtivas.length === 0) {
      // Sem conta pra debitar — só quita as parcelas (libera limite)
      await supabase.from('transacoes').update({ pago: true }).in('id', alvo.map(t => t.id));
      await enviarTexto(phone,
        `✅ Quitei *${alvo.length}* parcela(s) de *"${termo}"* (R$ ${totalPago.toFixed(2)}) e liberei o limite.\n` +
        `⚠️ Você não tem conta bancária cadastrada, então não debitei de nenhuma.`
      );
      return;
    }

    const opcoesTexto = contasAtivas
      .map((c, i) => `${i + 1}️⃣ ${c.nome} (R$ ${(c.saldo || 0).toFixed(2)})`)
      .join('\n');
    await enviarTexto(phone,
      `💳 Vou antecipar *${alvo.length}* parcela(s) de *"${termo}"* — total R$ ${totalPago.toFixed(2)}.\n\n` +
      `❓ *De qual conta pago?*\n${opcoesTexto}\n\nResponde com o número ou o nome.`
    );

    if (user?.id) {
      await criarPendente({
        userId: user.id,
        tipoPergunta: 'pagar_parcela_conta',
        contexto: {
          ids: alvo.map(t => t.id),
          termo,
          total: totalPago,
          opcoes: contasAtivas.map(c => ({ id: c.id, nome: c.nome })),
        },
      });
    }
    return;
  }
};