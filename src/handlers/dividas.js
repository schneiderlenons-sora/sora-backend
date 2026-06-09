const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/zapi');
const { oferecerDesconto } = require('../services/descontoConta');

const fmt = v => `R$ ${(parseFloat(v) || 0).toFixed(2).replace('.', ',')}`;
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

const TIPO_LABEL = {
  emprestimo:      'Empréstimo',
  financiamento:   'Financiamento',
  crediario:       'Crediário',
  cartao_rotativo: 'Cartão rotativo',
  cheque_especial: 'Cheque especial',
  consignado:      'Consignado',
  fies:            'FIES',
  outro:           'Outro',
};

// Detecta tipo pelo texto da mensagem (ajuda em "criar divida emprestimo banco x ...")
function detectarTipo(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('financiamento'))     return 'financiamento';
  if (m.includes('crediario') || m.includes('crediário')) return 'crediario';
  if (m.includes('consignado'))        return 'consignado';
  if (m.includes('fies'))              return 'fies';
  if (m.includes('rotativo'))          return 'cartao_rotativo';
  if (m.includes('cheque especial'))   return 'cheque_especial';
  if (m.includes('emprestimo') || m.includes('empréstimo')) return 'emprestimo';
  return 'emprestimo';
}

// Busca dívidas ativas por nome parcial (titulo OU credor)
async function encontrarDivida(grupoId, termo) {
  const t = (termo || '').trim();
  if (!t) return [];
  const { data } = await supabase.from('dividas')
    .select('*')
    .eq('grupo_id', grupoId)
    .in('status', ['ativa', 'em_atraso'])
    .or(`titulo.ilike.%${t}%,credor.ilike.%${t}%`);
  return data || [];
}

module.exports = async function handleDividas(data, ctx) {
  const { phone, grupoId, user } = ctx;

  // ── CRIAR DÍVIDA ───────────────────────────────────────────────
  if (data.acao === 'criar_divida') {
    const { titulo, credor, valor_total, parcelas_total, dia_vencimento, tipo, taxa_juros } = data;
    if (!titulo || !valor_total) {
      await enviarTexto(phone,
        '❌ Faltou informação. Exemplo:\n' +
        '"criar divida emprestimo nubank 5000 em 10x dia 15"'
      );
      return;
    }
    const vp = parcelas_total ? parseFloat(valor_total) / parseInt(parcelas_total, 10) : null;
    const { data: nova, error } = await supabase.from('dividas').insert({
      grupo_id:       grupoId,
      criado_por:     user.id,
      titulo:         titulo.trim(),
      credor:         credor?.trim() || null,
      tipo:           tipo || 'emprestimo',
      valor_total:    parseFloat(valor_total),
      valor_parcela:  vp,
      parcelas_total: parcelas_total ? parseInt(parcelas_total, 10) : null,
      parcelas_pagas: 0,
      taxa_juros:     taxa_juros ? parseFloat(taxa_juros) : null,
      dia_vencimento: dia_vencimento ? parseInt(dia_vencimento, 10) : null,
      data_inicio:    new Date().toISOString().slice(0, 10),
      status:         'ativa',
    }).select().single();
    if (error) { await enviarTexto(phone, `❌ Erro ao criar dívida: ${error.message}`); return; }

    const partes = [
      `✅ *Dívida cadastrada!*`,
      ``,
      `📌 ${nova.titulo}`,
      `🏷️ ${TIPO_LABEL[nova.tipo] || nova.tipo}`,
      `💵 Total: ${fmt(nova.valor_total)}`,
    ];
    if (nova.parcelas_total) partes.push(`📊 ${nova.parcelas_total}x de ${fmt(nova.valor_parcela)}`);
    if (nova.dia_vencimento) partes.push(`📅 Vencimento: todo dia ${nova.dia_vencimento}`);
    partes.push('', '🔔 Lembretes ativos. Para desligar: *cancelar lembrete ' + nova.titulo + '*');
    await enviarTexto(phone, partes.join('\n'));
    return;
  }

  // ── LISTAR DÍVIDAS ─────────────────────────────────────────────
  if (data.acao === 'listar_dividas') {
    const { data: dividas } = await supabase.from('dividas')
      .select('*').eq('grupo_id', grupoId)
      .in('status', ['ativa', 'em_atraso'])
      .order('dia_vencimento', { ascending: true });

    if (!dividas?.length) {
      await enviarTexto(phone, '✨ Você não tem dívidas ativas. Continue assim!');
      return;
    }

    let totalDevido = 0;
    const linhas = dividas.map(d => {
      const restantes = Math.max(0, (d.parcelas_total || 0) - (d.parcelas_pagas || 0));
      const saldo = restantes * (d.valor_parcela || 0) || d.valor_total;
      totalDevido += saldo;
      const sino = d.lembretes_ativos ? '🔔' : '🔕';
      const venc = d.dia_vencimento ? ` · dia ${d.dia_vencimento}` : '';
      const prog = d.parcelas_total ? ` · ${d.parcelas_pagas}/${d.parcelas_total}` : '';
      return `${sino} *${d.titulo}* — ${fmt(saldo)}${prog}${venc}`;
    });

    await enviarTexto(phone,
      `📋 *Suas dívidas ativas* (${dividas.length})\n\n` +
      linhas.join('\n') +
      `\n\n💰 *Total devido:* ${fmt(totalDevido)}\n\n` +
      `Para pagar: *pagar divida [nome] [valor]*`
    );
    return;
  }

  // ── PAGAR DÍVIDA ───────────────────────────────────────────────
  if (data.acao === 'pagar_divida') {
    const { termo, valor, tipo } = data;
    const matches = await encontrarDivida(grupoId, termo);

    if (matches.length === 0) {
      await enviarTexto(phone, `❌ Não encontrei dívida com *"${termo}"*. Use *minhas dividas* para listar.`);
      return;
    }
    if (matches.length > 1) {
      const lista = matches.map(d => `• ${d.titulo}${d.credor ? ` (${d.credor})` : ''}`).join('\n');
      await enviarTexto(phone, `🤔 Encontrei mais de uma dívida com *"${termo}"*:\n\n${lista}\n\nSeja mais específico no nome.`);
      return;
    }

    const divida = matches[0];
    const v = parseFloat(valor) || divida.valor_parcela;
    if (!v || v <= 0) {
      await enviarTexto(phone, `❌ Informe o valor. Ex: "pagar divida ${divida.titulo} 250"`);
      return;
    }

    const tipoPg = tipo || 'parcela';
    const novasPagas = (divida.parcelas_pagas || 0) + (tipoPg === 'juros_atraso' ? 0 : 1);
    const total = divida.parcelas_total || 0;
    const quitada = total > 0 && novasPagas >= total;

    await supabase.from('divida_pagamentos').insert({
      divida_id:      divida.id,
      user_id:        user.id,
      numero_parcela: tipoPg === 'juros_atraso' ? null : novasPagas,
      valor:          v,
      tipo:           tipoPg,
      data_pagamento: new Date().toISOString().slice(0, 10),
    });

    await supabase.from('dividas').update({
      parcelas_pagas: novasPagas,
      status:         quitada ? 'quitada' : divida.status,
      data_quitacao:  quitada ? new Date().toISOString().slice(0, 10) : null,
      updated_at:     new Date().toISOString(),
    }).eq('id', divida.id);

    if (quitada) {
      await enviarTexto(phone,
        `🎉 *DÍVIDA QUITADA!* 🎉\n\n` +
        `✅ *${divida.titulo}* foi 100% paga.\n` +
        `Parabéns pela disciplina! 💪`
      );
    } else {
      const restantes = total > 0 ? total - novasPagas : null;
      const saldo = restantes != null ? restantes * (divida.valor_parcela || 0) : null;
      const partes = [
        `✅ *Pagamento registrado*`,
        ``,
        `📌 ${divida.titulo}`,
        `💵 Valor pago: ${fmt(v)} (${cap(tipoPg.replace('_', ' '))})`,
      ];
      if (total > 0) partes.push(`📊 Progresso: ${novasPagas}/${total}`);
      if (saldo != null) partes.push(`💰 Saldo devedor: ${fmt(saldo)}`);
      await enviarTexto(phone, partes.join('\n'));
    }
    // Pergunta se quer descontar de uma conta (cria a transação de saída)
    await oferecerDesconto({ user, phone, grupoId, valor: v, categoria: 'Dívidas', observacao: `Pagamento: ${divida.titulo}` });
    return;
  }

  // ── QUITAR DÍVIDA INTEIRA ──────────────────────────────────────
  if (data.acao === 'quitar_divida') {
    const matches = await encontrarDivida(grupoId, data.termo);
    if (matches.length === 0) {
      await enviarTexto(phone, `❌ Não encontrei dívida com *"${data.termo}"*.`);
      return;
    }
    if (matches.length > 1) {
      const lista = matches.map(d => `• ${d.titulo}`).join('\n');
      await enviarTexto(phone, `🤔 Mais de uma dívida com *"${data.termo}"*:\n${lista}\n\nSeja mais específico.`);
      return;
    }
    const divida = matches[0];
    const restantes = Math.max(0, (divida.parcelas_total || 0) - (divida.parcelas_pagas || 0));
    const valorQuitacao = parseFloat(data.valor) || (restantes * (divida.valor_parcela || 0));

    await supabase.from('divida_pagamentos').insert({
      divida_id:      divida.id,
      user_id:        user.id,
      valor:          valorQuitacao,
      tipo:           'quitacao',
      data_pagamento: new Date().toISOString().slice(0, 10),
      observacao:     'Quitação via WhatsApp',
    });

    await supabase.from('dividas').update({
      parcelas_pagas: divida.parcelas_total || divida.parcelas_pagas,
      status:         'quitada',
      data_quitacao:  new Date().toISOString().slice(0, 10),
      updated_at:     new Date().toISOString(),
    }).eq('id', divida.id);

    await enviarTexto(phone,
      `🎉 *DÍVIDA QUITADA!*\n\n` +
      `✅ ${divida.titulo} — ${fmt(valorQuitacao)}\n` +
      `Você está livre dessa! 🙌`
    );
    await oferecerDesconto({ user, phone, grupoId, valor: valorQuitacao, categoria: 'Dívidas', observacao: `Quitação: ${divida.titulo}` });
    return;
  }

  // ── CANCELAR LEMBRETE (uma divida especifica OU todas) ─────────
  if (data.acao === 'cancelar_lembrete_divida') {
    // Sem termo → desliga TODOS lembretes de dividas do usuario
    if (!data.termo || /^(tudo|todos|todas)$/i.test(data.termo.trim())) {
      await supabase.from('users').update({ lembretes_dividas: false }).eq('phone', phone);
      await enviarTexto(phone,
        `🔕 *Lembretes de dívidas desativados.*\n\n` +
        `Você não receberá mais avisos de vencimento.\n` +
        `Para reativar: *ativar lembretes dividas*`
      );
      return;
    }
    const matches = await encontrarDivida(grupoId, data.termo);
    if (matches.length === 0) {
      await enviarTexto(phone, `❌ Não encontrei dívida com *"${data.termo}"*.`);
      return;
    }
    if (matches.length > 1) {
      const lista = matches.map(d => `• ${d.titulo}`).join('\n');
      await enviarTexto(phone, `🤔 Mais de uma dívida:\n${lista}\n\nSeja mais específico.`);
      return;
    }
    await supabase.from('dividas').update({ lembretes_ativos: false }).eq('id', matches[0].id);
    await enviarTexto(phone,
      `🔕 Lembretes desativados para *${matches[0].titulo}*.\n` +
      `Para reativar: *ativar lembrete ${matches[0].titulo}*`
    );
    return;
  }

  // ── REATIVAR LEMBRETE ──────────────────────────────────────────
  if (data.acao === 'ativar_lembrete_divida') {
    if (!data.termo || /^(tudo|todos|todas|dividas)$/i.test(data.termo.trim())) {
      await supabase.from('users').update({ lembretes_dividas: true }).eq('phone', phone);
      await enviarTexto(phone, `🔔 *Lembretes de dívidas reativados.*`);
      return;
    }
    const matches = await encontrarDivida(grupoId, data.termo);
    if (matches.length === 0) {
      await enviarTexto(phone, `❌ Não encontrei dívida com *"${data.termo}"*.`);
      return;
    }
    if (matches.length > 1) {
      const lista = matches.map(d => `• ${d.titulo}`).join('\n');
      await enviarTexto(phone, `🤔 Mais de uma dívida:\n${lista}\n\nSeja mais específico.`);
      return;
    }
    await supabase.from('dividas').update({ lembretes_ativos: true }).eq('id', matches[0].id);
    await enviarTexto(phone, `🔔 Lembretes reativados para *${matches[0].titulo}*.`);
    return;
  }
};

module.exports.detectarTipo = detectarTipo;
