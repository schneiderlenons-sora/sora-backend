const supabase = require('../db/supabase');
const { enviarTexto } = require('../services/mensageiro');
const { gerarDicas }  = require('../services/ia');
const { oferecerDesconto } = require('../services/descontoConta');

// Verifica plano Black
async function checarBlack(phone) {
  const { data } = await supabase.from('users').select('plano').eq('phone', phone).single();
  return data?.plano === 'black';
}

const BLOQUEADO = '🚫 Esta funcionalidade é exclusiva do plano *Black*.\nAcesse o painel para fazer upgrade.';

module.exports = async function handleInvestimentos(data, ctx) {
  const { phone, grupoId, user } = ctx;

  // Todas as ações deste handler exigem plano Black
  if (!(await checarBlack(phone))) {
    await enviarTexto(phone, BLOQUEADO);
    return;
  }

  // ── CRIAR INVESTIMENTO ──────────────────────────────────────────
  if (data.acao === 'criar_investimento') {
    const qtd   = data.quantidade || 1;
    const preco = data.precoUnitario || data.valorAportado;
    const { data: inv } = await supabase.from('investimentos').insert({
      grupo_id:       grupoId,
      tipo:           data.tipo,
      nome:           data.nome,
      ticker:         data.ticker || null,
      quantidade:     qtd,
      preco_unitario: preco,
      valor_aportado: data.valorAportado,
      valor_atual:    qtd * preco,
      data_compra:    data.dataCompra || new Date().toISOString()
    }).select().single();

    await enviarTexto(phone,
      `✅ *Investimento criado!*\n\n` +
      `📌 ${inv.nome} (${inv.tipo})\n` +
      `💵 Aportado: R$ ${inv.valor_aportado.toFixed(2)}\n` +
      `📊 Valor atual: R$ ${inv.valor_atual.toFixed(2)}`
    );
    await oferecerDesconto({ user, phone, grupoId, valor: inv.valor_aportado, categoria: 'Investimentos', observacao: `Aporte: ${inv.nome}` });
    return;
  }

  // ── LISTAR INVESTIMENTOS ────────────────────────────────────────
  if (data.acao === 'listar_investimentos') {
    const { data: invs } = await supabase.from('investimentos')
      .select('*').eq('grupo_id', grupoId).order('created_at');

    if (!invs?.length) {
      await enviarTexto(phone, '📭 Nenhum investimento cadastrado.\nDiga "criar investimento de R$ 1000 em CDB" para começar.');
      return;
    }

    let totalAportado = 0, totalAtual = 0, totalDividendos = 0;
    const agrupado = {};

    let msg = '📈 *SEUS INVESTIMENTOS:*\n\n';
    for (const i of invs) {
      totalAportado    += i.valor_aportado;
      totalAtual       += i.valor_atual;
      totalDividendos  += i.dividendos_acumulados || 0;
      agrupado[i.tipo]  = (agrupado[i.tipo] || 0) + i.valor_atual;

      const rent = ((i.rentabilidade || 0) * 100).toFixed(2);
      msg += `💰 *${i.nome}* (${i.tipo})\n`;
      msg += `   Aportado: R$ ${i.valor_aportado.toFixed(2)}\n`;
      msg += `   Atual: R$ ${i.valor_atual.toFixed(2)}\n`;
      msg += `   Dividendos: R$ ${(i.dividendos_acumulados||0).toFixed(2)}\n`;
      msg += `   Rentabilidade: ${rent}%\n\n`;
    }

    const patrimonioTotal = totalAtual + totalDividendos;
    const rentGeral = totalAportado > 0
      ? (((patrimonioTotal - totalAportado) / totalAportado) * 100).toFixed(2)
      : '0.00';

    msg += `*━━ RESUMO ━━*\n`;
    msg += `💵 Total aportado: R$ ${totalAportado.toFixed(2)}\n`;
    msg += `📊 Valor atual: R$ ${totalAtual.toFixed(2)}\n`;
    msg += `💰 Dividendos: R$ ${totalDividendos.toFixed(2)}\n`;
    msg += `📈 Patrimônio total: R$ ${patrimonioTotal.toFixed(2)}\n`;
    msg += `🎯 Rentabilidade geral: ${rentGeral}%\n\n`;
    msg += `*Distribuição:*\n`;
    for (const [tipo, val] of Object.entries(agrupado)) {
      const pct = patrimonioTotal > 0 ? ((val/patrimonioTotal)*100).toFixed(1) : 0;
      msg += `• ${tipo}: R$ ${val.toFixed(2)} (${pct}%)\n`;
    }

    await enviarTexto(phone, msg);
    return;
  }

  // ── REGISTRAR APORTE ────────────────────────────────────────────
  if (data.acao === 'registrar_aporte') {
    const valor = parseFloat(data.valor);

    await supabase.from('aportes').insert({
      grupo_id:        grupoId,
      investimento_id: data.investimentoId || null,
      valor,
      descricao:       data.descricao || 'Aporte manual'
    });

    if (data.investimentoId) {
      const { data: inv } = await supabase.from('investimentos')
        .select('valor_aportado, valor_atual').eq('id', data.investimentoId).single();
      if (inv) {
        await supabase.from('investimentos').update({
          valor_aportado: inv.valor_aportado + valor,
          valor_atual:    inv.valor_atual    + valor
        }).eq('id', data.investimentoId);
      }
    }

    await enviarTexto(phone, `💰 Aporte de R$ ${valor.toFixed(2)} registrado com sucesso!`);
    await oferecerDesconto({ user, phone, grupoId, valor, categoria: 'Investimentos', observacao: `Aporte: ${data.descricao || 'investimento'}` });
    return;
  }

  // ── LISTAR APORTES ──────────────────────────────────────────────
  if (data.acao === 'listar_aportes') {
    const { data: aportes } = await supabase.from('aportes')
      .select('*').eq('grupo_id', grupoId)
      .order('data', { ascending: false }).limit(10);

    if (!aportes?.length) {
      await enviarTexto(phone, '📭 Nenhum aporte registrado ainda.');
      return;
    }

    const lista = aportes.map(a => {
      const dt = new Date(a.data).toLocaleDateString('pt-BR');
      return `📅 ${dt}: R$ ${a.valor.toFixed(2)} — ${a.descricao}`;
    }).join('\n');

    await enviarTexto(phone, `📊 *Últimos aportes:*\n\n${lista}`);
    return;
  }

  // ── CRIAR META ──────────────────────────────────────────────────
  if (data.acao === 'criar_meta') {
    const taxa     = data.taxaAnual || 10;
    const n        = data.prazoAnos * 12;
    const jurosMes = Math.pow(1 + taxa/100, 1/12) - 1;
    let aporteMensal = (data.valorObjetivo * jurosMes) / (Math.pow(1 + jurosMes, n) - 1);
    if (!isFinite(aporteMensal)) aporteMensal = data.valorObjetivo / n;

    const { data: meta } = await supabase.from('metas').insert({
      grupo_id:               grupoId,
      nome:                   data.nome,
      valor_objetivo:         data.valorObjetivo,
      prazo_anos:             data.prazoAnos,
      taxa_anual:             taxa,
      aporte_mensal_sugerido: parseFloat(aporteMensal.toFixed(2)),
      investimento_id:        data.investimentoId || null
    }).select().single();

    await enviarTexto(phone,
      `🎯 *Meta criada!*\n\n` +
      `📌 ${meta.nome}\n` +
      `💵 Objetivo: R$ ${meta.valor_objetivo.toFixed(2)}\n` +
      `⏳ Prazo: ${meta.prazo_anos} anos\n` +
      `📈 Taxa: ${taxa}% a.a.\n` +
      `💰 Aporte mensal sugerido: R$ ${meta.aporte_mensal_sugerido.toFixed(2)}`
    );
    return;
  }

  // ── LISTAR METAS ────────────────────────────────────────────────
  if (data.acao === 'listar_metas') {
    const { data: metas } = await supabase.from('metas')
      .select('*').eq('grupo_id', grupoId);

    if (!metas?.length) {
      await enviarTexto(phone, '📭 Nenhuma meta cadastrada.\nDiga "criar meta de R$ 50000 em 2 anos" para começar.');
      return;
    }

    const lista = metas.map(m =>
      `🎯 *${m.nome}*\n   Objetivo: R$ ${m.valor_objetivo.toFixed(2)} em ${m.prazo_anos} anos\n   Aporte: R$ ${m.aporte_mensal_sugerido.toFixed(2)}/mês\n   Status: ${m.status}`
    ).join('\n\n');

    await enviarTexto(phone, `🎯 *SUAS METAS:*\n\n${lista}`);
    return;
  }

  // ── PROGRESSO DA META ───────────────────────────────────────────
  if (data.acao === 'progresso_meta') {
    const { data: meta } = await supabase.from('metas')
      .select('*').eq('grupo_id', grupoId).eq('id', data.metaId).single();

    if (!meta) { await enviarTexto(phone, '❌ Meta não encontrada.'); return; }

    const { data: ap } = await supabase.from('aportes')
      .select('valor').eq('grupo_id', grupoId)
      .eq('investimento_id', meta.investimento_id || null);

    const totalAportado  = (ap||[]).reduce((s,a) => s + a.valor, 0);
    const faltante       = meta.valor_objetivo - totalAportado;
    const pct            = Math.min((totalAportado / meta.valor_objetivo) * 100, 100);
    const mesesRestantes = faltante > 0 ? Math.ceil(faltante / meta.aporte_mensal_sugerido) : 0;

    await enviarTexto(phone,
      `🎯 *Progresso: ${meta.nome}*\n\n` +
      `✅ Aportado: R$ ${totalAportado.toFixed(2)} (${pct.toFixed(1)}%)\n` +
      `🏁 Objetivo: R$ ${meta.valor_objetivo.toFixed(2)}\n` +
      `📉 Faltam: R$ ${Math.max(faltante,0).toFixed(2)}\n` +
      `⏱️ Tempo restante: ~${mesesRestantes} meses\n` +
      `📊 Status: ${meta.status}`
    );
    return;
  }

  // ── SUGERIR ALOCAÇÃO ────────────────────────────────────────────
  if (data.acao === 'sugerir_alocacao') {
    const { data: meta } = await supabase.from('metas')
      .select('*').eq('grupo_id', grupoId).eq('id', data.metaId).single();
    if (!meta) { await enviarTexto(phone, '❌ Meta não encontrada.'); return; }

    const perfil = (data.perfil || 'moderado').toLowerCase();
    let sugestao = '';

    if (meta.prazo_anos <= 3) {
      sugestao = '🛡️ *Prazo curto (até 3 anos):*\n• 80% Renda Fixa (Tesouro Selic, CDB)\n• 20% Fundos DI\n⚠️ Evite renda variável.';
    } else if (meta.prazo_anos <= 7) {
      sugestao = '⚖️ *Prazo médio (4–7 anos):*\n• 60% Renda Fixa (Tesouro IPCA+)\n• 30% Ações/FIIs\n• 10% Liquidez';
    } else {
      sugestao = '🚀 *Prazo longo (>7 anos):*\n• 40% Renda Fixa\n• 50% Ações/ETFs/FIIs\n• 10% Reserva\n💡 Considere IVVB11 para exposição internacional.';
    }

    if (perfil === 'conservador') sugestao = '🛡️ *Perfil Conservador:* Prefira Tesouro Selic e CDBs de bancos sólidos. Evite ações.\n\n' + sugestao;
    if (perfil === 'agressivo')   sugestao = '⚡ *Perfil Agressivo:* Aumente exposição em ações e ETFs. Aceite mais volatilidade por mais retorno.\n\n' + sugestao;

    await enviarTexto(phone, `📊 *Sugestão para "${meta.nome}":*\n\n${sugestao}\n\n⚠️ Consulte um especialista antes de investir.`);
    return;
  }

  // ── GERAR DICAS ─────────────────────────────────────────────────
  if (data.acao === 'gerar_dicas') {
    const trintaDias = new Date();
    trintaDias.setDate(trintaDias.getDate() - 30);

    const { data: txs } = await supabase.from('transacoes')
      .select('categoria, valor').eq('grupo_id', grupoId)
      .eq('tipo', 'Gasto').gte('data', trintaDias.toISOString());

    if (!txs?.length) {
      await enviarTexto(phone, '📭 Sem gastos nos últimos 30 dias para analisar.');
      return;
    }

    const cats = {};
    let total = 0;
    txs.forEach(t => { cats[t.categoria] = (cats[t.categoria]||0) + t.valor; total += t.valor; });
    const resumo = `Total: R$ ${total.toFixed(2)}\n` +
      Object.entries(cats).sort((a,b)=>b[1]-a[1])
        .map(([c,v]) => `- ${c}: R$ ${v.toFixed(2)}`).join('\n');

    await enviarTexto(phone, '🧠 Analisando seus gastos... aguarde um segundo.');
    const dicas = await gerarDicas(resumo);
    await enviarTexto(phone, `💡 *Dicas personalizadas:*\n\n${dicas}`);
    return;
  }

  // ── VER DIVIDENDOS ──────────────────────────────────────────────
  if (data.acao === 'ver_dividendos') {
    const { data: invs } = await supabase.from('investimentos')
      .select('nome, ticker, dividendos_acumulados')
      .eq('grupo_id', grupoId).gt('dividendos_acumulados', 0);

    if (!invs?.length) {
      await enviarTexto(phone, '📭 Nenhum dividendo recebido ainda (ou sem ativos com ticker cadastrado).');
      return;
    }

    let total = 0;
    const lista = invs.map(i => {
      total += i.dividendos_acumulados;
      return `📌 ${i.nome}${i.ticker ? ` (${i.ticker})` : ''}: R$ ${i.dividendos_acumulados.toFixed(2)}`;
    }).join('\n');

    await enviarTexto(phone, `💰 *Dividendos recebidos:*\n\n${lista}\n\n💵 *Total: R$ ${total.toFixed(2)}*`);
    return;
  }
};