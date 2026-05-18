const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/zapi');

module.exports = async function handleParcelas(data, ctx) {
  const { phone, grupoId, user } = ctx;

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
    if (wallet.saldo < valorTotal) {
      await enviarTexto(phone, `⚠️ Limite insuficiente em *${wallet.nome}*.\nDisponível: R$ ${wallet.saldo.toFixed(2)} | Necessário: R$ ${valorTotal.toFixed(2)}`);
      return;
    }

    // Debita do limite do cartão
    await supabase.from('wallets')
      .update({ saldo: wallet.saldo - valorTotal })
      .eq('id', wallet.id);

    // Data da primeira parcela (+30 dias)
    const primeiroVenc = new Date();
    primeiroVenc.setDate(primeiroVenc.getDate() + 30);

    // Registra as parcelas
    await supabase.from('parcelas').insert({
      grupo_id:               grupoId,
      descricao,
      valor_total:            valorTotal,
      valor_parcela:          valorParcela,
      total_parcelas:         numParcelas,
      parcelas_pagas:         0,
      data_proxima_vencimento: primeiroVenc.toISOString(),
      categoria:              categoria || 'Outros',
      carteira:               wallet.nome,
      ativa:                  true
    });

    await enviarTexto(phone,
      `✅ *Compra parcelada registrada!*\n\n` +
      `📦 ${descricao}\n` +
      `💳 Cartão: ${wallet.nome}\n` +
      `💵 Total: R$ ${valorTotal.toFixed(2)} em ${numParcelas}x de R$ ${valorParcela.toFixed(2)}\n` +
      `📅 1ª parcela: ${primeiroVenc.toLocaleDateString('pt-BR')}\n\n` +
      `⚠️ Para pagar cada parcela use:\n"pagar parcela da ${descricao}"`
    );
    return;
  }

  // ── PAGAR PARCELA (instrução de transferência) ──────────────────
  if (data.acao === 'pagar_parcela') {
    const { data: parcela } = await supabase.from('parcelas')
      .select('*').eq('grupo_id', grupoId)
      .ilike('descricao', `%${data.descricao}%`)
      .eq('ativa', true).single();

    if (!parcela) {
      await enviarTexto(phone, `❌ Parcela *"${data.descricao}"* não encontrada.`);
      return;
    }
    if (parcela.parcelas_pagas >= parcela.total_parcelas) {
      await enviarTexto(phone, `✅ Todas as parcelas de *"${parcela.descricao}"* já foram pagas!`);
      return;
    }

    const num = parcela.parcelas_pagas + 1;
    await enviarTexto(phone,
      `💳 Para pagar a parcela *${num}/${parcela.total_parcelas}* de R$ ${parcela.valor_parcela.toFixed(2)} da compra *"${parcela.descricao}"*:\n\n` +
      `1️⃣ Transfira R$ ${parcela.valor_parcela.toFixed(2)} para o cartão:\n` +
      `"transferir ${parcela.valor_parcela.toFixed(2)} do [sua conta] para ${parcela.carteira}"\n\n` +
      `2️⃣ Depois confirme:\n` +
      `"parcela paga ${parcela.descricao}"`
    );
    return;
  }

  // ── CONFIRMAR PAGAMENTO ─────────────────────────────────────────
  if (data.acao === 'confirmar_pagamento_parcela') {
    const { data: parcela } = await supabase.from('parcelas')
      .select('*').eq('grupo_id', grupoId)
      .ilike('descricao', `%${data.descricao}%`)
      .eq('ativa', true).single();

    if (!parcela) {
      await enviarTexto(phone, `❌ Parcela *"${data.descricao}"* não encontrada.`);
      return;
    }

    const novasPagas = parcela.parcelas_pagas + 1;
    const quitada   = novasPagas >= parcela.total_parcelas;

    await supabase.from('parcelas').update({
      parcelas_pagas:          novasPagas,
      ativa:                   !quitada,
      data_proxima_vencimento: quitada ? null : new Date(Date.now() + 30*24*60*60*1000).toISOString()
    }).eq('id', parcela.id);

    if (quitada) {
      await enviarTexto(phone, `🎉 Parabéns! Você quitou todas as parcelas de *"${parcela.descricao}"*! 🎉`);
    } else {
      const prox = new Date(Date.now() + 30*24*60*60*1000);
      await enviarTexto(phone,
        `✅ Parcela *${novasPagas}/${parcela.total_parcelas}* de *"${parcela.descricao}"* confirmada!\n` +
        `📅 Próxima vence em ${prox.toLocaleDateString('pt-BR')}.`
      );
    }
  }
};