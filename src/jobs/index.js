const cron      = require('node-cron');
const supabase  = require('../db/supabase');
const { enviarTexto } = require('../services/zapi');
const { criarPendente } = require('../services/pendentes');
const yahooFinance    = require('yahoo-finance2').default;

// Gera ID curto de 6 caracteres
const gerarId = () => Math.random().toString(36).substring(2,8).toUpperCase();

// Busca o telefone do dono de um grupo
async function phoneDono(grupoId) {
  const { data: grupo } = await supabase.from('grupos').select('dono_id').eq('id', grupoId).single();
  if (!grupo) return null;
  const { data: user } = await supabase.from('users').select('phone').eq('id', grupo.dono_id).single();
  return user?.phone || null;
}

// Busca o dono do grupo (id + phone) — preciso do id pra criar pendentes.
async function donoDoGrupo(grupoId) {
  const { data: grupo } = await supabase.from('grupos').select('dono_id').eq('id', grupoId).single();
  if (!grupo) return null;
  const { data: user } = await supabase.from('users').select('id, phone').eq('id', grupo.dono_id).single();
  return user || null;
}

// Envia o aviso de fatura (fechamento ou vencimento) e, se houver contas
// bancárias, cria um pendente pra Sora pagar quando o user responder o número.
async function avisarFatura({ titulo, venc, total, emAberto, contasAtivas, dono, nomeCartao }) {
  const vencLinha = venc ? `\n📅 Vence dia ${venc}` : '';
  if (!contasAtivas.length) {
    await enviarTexto(dono.phone,
      `${titulo}\n💵 Total: R$ ${total.toFixed(2)}${vencLinha}\n\n` +
      `Você ainda não tem conta bancária cadastrada pra eu debitar — quando cadastrar, eu pago pra você.`);
    return;
  }
  const opcoesTexto = contasAtivas
    .map((x, i) => `${i + 1}️⃣ ${x.nome} (R$ ${(x.saldo || 0).toFixed(2)})`).join('\n');
  await enviarTexto(dono.phone,
    `${titulo}\n💵 Total: R$ ${total.toFixed(2)}${vencLinha}\n\n` +
    `❓ *Quer que eu pague? De qual conta?*\n${opcoesTexto}\n\n` +
    `Responde com o número ou o nome — ou ignore se for pagar por fora.`);
  await criarPendente({
    userId: dono.id,
    tipoPergunta: 'pagar_parcela_conta',
    contexto: {
      ids: emAberto.map(t => t.id),
      termo: nomeCartao || 'fatura',
      total,
      modo: 'fatura',
      opcoes: contasAtivas.map(x => ({ id: x.id, nome: x.nome })),
    },
    expiresInMin: 3 * 24 * 60, // 3 dias — oferta de pagar fatura não expira em 10min
  });
}

// Processa fechamento e vencimento das faturas dos cartões de crédito.
// Por cartão (wallets.dia_fechamento / dia_vencimento), lê as transações
// não-pagas até hoje (fatura em aberto) e avisa/oferece pagamento.
async function processarFaturas(hoje, diaHoje, fimHoje) {
  const hojeStr = hoje.toISOString().slice(0, 10);

  const { data: cartoes } = await supabase.from('wallets')
    .select('id, nome, grupo_id, dia_fechamento, dia_vencimento, ultimo_aviso_fechamento, ultimo_aviso_vencimento')
    .eq('tipo', 'Crédito')
    .or(`dia_fechamento.eq.${diaHoje},dia_vencimento.eq.${diaHoje}`);

  for (const c of cartoes || []) {
    const fecha = c.dia_fechamento === diaHoje && c.ultimo_aviso_fechamento !== hojeStr;
    const vence = c.dia_vencimento === diaHoje && c.ultimo_aviso_vencimento !== hojeStr;
    if (!fecha && !vence) continue;

    // Fatura em aberto = gastos não-pagos do cartão até hoje (parcelas futuras
    // ficam de fora, pois têm data nos meses seguintes).
    const { data: txs } = await supabase.from('transacoes')
      .select('id, valor')
      .eq('grupo_id', c.grupo_id)
      .eq('tipo', 'Gasto')
      .eq('pago', false)
      .ilike('carteira_nome', c.nome)
      .lte('data', fimHoje.toISOString());

    const emAberto = txs || [];
    const total = emAberto.reduce((s, t) => s + (t.valor || 0), 0);
    if (total <= 0) continue;

    const dono = await donoDoGrupo(c.grupo_id);
    if (!dono?.phone) continue;

    const { data: contas } = await supabase.from('wallets')
      .select('id, nome, saldo, arquivada')
      .eq('grupo_id', c.grupo_id)
      .neq('tipo', 'Crédito')
      .order('created_at', { ascending: true });
    const contasAtivas = (contas || []).filter(x => !x.arquivada);

    // Fechamento tem prioridade se cair no mesmo dia do vencimento.
    if (fecha) {
      await avisarFatura({
        titulo: `💳 *Fatura do ${c.nome} fechou*`,
        venc: c.dia_vencimento, total, emAberto, contasAtivas, dono, nomeCartao: c.nome,
      });
      await supabase.from('wallets').update({ ultimo_aviso_fechamento: hojeStr }).eq('id', c.id);
    } else if (vence) {
      await avisarFatura({
        titulo: `⏰ *Fatura do ${c.nome} vence hoje*`,
        venc: c.dia_vencimento, total, emAberto, contasAtivas, dono, nomeCartao: c.nome,
      });
      await supabase.from('wallets').update({ ultimo_aviso_vencimento: hojeStr }).eq('id', c.id);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// JOB 1 — A cada hora: recorrências, lembretes, parcelas, fatura
// ─────────────────────────────────────────────────────────────────
cron.schedule('0 * * * *', async () => {
  console.log('⏰ Processando tarefas agendadas...');
  const hoje      = new Date();
  const diaHoje   = hoje.getDate();
  const inicioHoje = new Date(hoje); inicioHoje.setHours(0,0,0,0);
  const fimHoje    = new Date(hoje); fimHoje.setHours(23,59,59,999);

  // ── 1A. CONTAS FIXAS (recorrências) ────────────────────────────
  const { data: recorrencias } = await supabase
    .from('recorrencias')
    .select('*')
    .eq('dia_vencimento', diaHoje)
    .eq('ativa', true);

  for (const rec of recorrencias || []) {
    // Verifica se já foi lançado hoje
    const { data: jaLancado } = await supabase
      .from('transacoes')
      .select('id')
      .eq('grupo_id', rec.grupo_id)
      .eq('categoria', rec.categoria)
      .eq('valor', rec.valor)
      .gte('data', inicioHoje.toISOString())
      .lte('data', fimHoje.toISOString())
      .single();

    if (jaLancado) continue;

    const idCurto = gerarId();
    await supabase.from('transacoes').insert({
      id_curto:      idCurto,
      grupo_id:      rec.grupo_id,
      tipo:          rec.tipo,
      categoria:     rec.categoria || 'Outros',
      valor:         rec.valor,
      observacao:    `[Recorrente] ${rec.descricao}`,
      carteira_nome: rec.carteira || 'Dinheiro',
      pago:          true,
      data:          new Date().toISOString()
    });

    // Atualiza saldo da carteira
    const { data: wallet } = await supabase.from('wallets')
      .select('id, saldo').eq('grupo_id', rec.grupo_id).ilike('nome', rec.carteira || 'Dinheiro').single();
    if (wallet) {
      const mult = rec.tipo === 'Gasto' ? -1 : 1;
      await supabase.from('wallets').update({ saldo: wallet.saldo + (rec.valor * mult) }).eq('id', wallet.id);
    }

    const phone = await phoneDono(rec.grupo_id);
    if (phone) {
      await enviarTexto(phone,
        `🔁 *Lançamento automático:*\n${rec.tipo === 'Gasto' ? '🔴' : '🟢'} ${rec.descricao} — R$ ${rec.valor.toFixed(2)}\nID: \`${idCurto}\``
      );
    }
  }

  // ── 1B. LEMBRETES ───────────────────────────────────────────────
  const { data: lembretes } = await supabase
    .from('lembretes')
    .select('*')
    .eq('ativo', true)
    .eq('enviado', false)
    .lte('data_vencimento', fimHoje.toISOString());

  for (const lem of lembretes || []) {
    const phone = await phoneDono(lem.grupo_id);
    if (phone) {
      await enviarTexto(phone,
        `🔔 *LEMBRETE:*\n` +
        `${lem.tipo === 'pagar' ? '💸 Pagar' : '💰 Receber'} *${lem.descricao}*\n` +
        `Valor: R$ ${(lem.valor||0).toFixed(2)}\n` +
        `Vencimento: ${new Date(lem.data_vencimento).toLocaleDateString('pt-BR')}`
      );
    }
    await supabase.from('lembretes').update({ enviado: true }).eq('id', lem.id);
  }

  // ── 1C. PARCELAS VENCENDO ───────────────────────────────────────
  const { data: parcelas } = await supabase
    .from('parcelas')
    .select('*')
    .eq('ativa', true)
    .lte('data_proxima_vencimento', fimHoje.toISOString());

  for (const p of parcelas || []) {
    if (p.parcelas_pagas >= p.total_parcelas) continue;
    const phone = await phoneDono(p.grupo_id);
    if (phone) {
      await enviarTexto(phone,
        `🔔 *PARCELA VENCE HOJE:*\n` +
        `📦 ${p.descricao} — ${p.parcelas_pagas + 1}/${p.total_parcelas}\n` +
        `💵 R$ ${p.valor_parcela.toFixed(2)} no cartão *${p.carteira}*\n\n` +
        `Para pagar: "pagar parcela da ${p.descricao}"`
      );
    }
  }

  // ── 1D. FATURA DOS CARTÕES (fechamento + vencimento) ────────────
  // Por cartão: avisa quando fecha e quando vence, oferecendo pagar
  // (debita a conta escolhida e libera o limite). Ver processarFaturas.
  try {
    await processarFaturas(hoje, diaHoje, fimHoje);
  } catch (e) {
    console.warn('[jobs] processarFaturas falhou:', e.message);
  }
});

// ─────────────────────────────────────────────────────────────────
// JOB 1F — A cada 15 min: lembretes de MEDICAMENTOS
// Verifica horários cadastrados e envia WhatsApp.
// Dedup em memória (lembretesMedHoje) — reseta à meia-noite.
// ─────────────────────────────────────────────────────────────────
const lembretesMedHoje = new Set();
let diaResetMed = new Date().toDateString();

cron.schedule('*/15 * * * *', async () => {
  const agora = new Date();
  if (agora.toDateString() !== diaResetMed) {
    lembretesMedHoje.clear();
    diaResetMed = agora.toDateString();
  }
  const diaSemana = agora.getDay() === 0 ? 7 : agora.getDay(); // 1=seg ... 7=dom
  const minutosAgora = agora.getHours() * 60 + agora.getMinutes();

  const { data: meds } = await supabase
    .from('medicamentos')
    .select('id, grupo_id, user_id, nome, dosagem, horarios, dias_semana, estoque_atual, estoque_alerta, lembrete_ativo')
    .eq('ativo', true)
    .eq('lembrete_ativo', true);

  for (const med of meds || []) {
    if (!med.dias_semana?.includes(diaSemana)) continue;
    if (!med.horarios?.length) continue;

    for (const h of med.horarios) {
      const [hh, mm] = String(h).split(':').map(Number);
      const minHorario = hh * 60 + mm;
      const diff = minutosAgora - minHorario;
      // Janela: 0 a 14 min depois do horário (a cada 15 min, cobre tudo)
      if (diff < 0 || diff >= 15) continue;

      const key = `${med.id}|${h}|${agora.toDateString()}`;
      if (lembretesMedHoje.has(key)) continue;

      const { data: user } = await supabase.from('users').select('phone').eq('id', med.user_id).single();
      if (!user?.phone) continue;

      const estoqueAviso = med.estoque_atual != null && med.estoque_atual <= (med.estoque_alerta || 5)
        ? `\n⚠️ Estoque baixo: ${med.estoque_atual} restantes`
        : '';
      await enviarTexto(user.phone,
        `💊 *Hora de tomar ${med.nome}* ${med.dosagem || ''}\n` +
        `Quando tomar, responda *tomei ${med.nome}* pra eu marcar.${estoqueAviso}`);
      lembretesMedHoje.add(key);
      console.log(`💊 Lembrete med enviado: ${med.nome} → ${user.phone}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────
// JOB 1G — Todo dia às 09:00: lembretes de CONSULTAS (24h antes)
// E retornos médicos próximos (7 dias)
// ─────────────────────────────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  console.log('🩺 Processando lembretes de consultas...');
  const hoje = new Date();
  const amanha = new Date(hoje); amanha.setDate(amanha.getDate() + 1);
  const amanhaStr = amanha.toISOString().slice(0, 10);
  const em7d = new Date(hoje); em7d.setDate(em7d.getDate() + 7);
  const em7dStr = em7d.toISOString().slice(0, 10);

  // Consultas de amanhã com lembrete ativo
  const { data: consultas } = await supabase
    .from('consultas').select('id, grupo_id, user_id, profissional, especialidade, data, hora, local')
    .eq('status', 'agendada').eq('lembrete_ativo', true).eq('data', amanhaStr);

  for (const c of consultas || []) {
    const { data: user } = await supabase.from('users').select('phone').eq('id', c.user_id).single();
    if (!user?.phone) continue;
    const partes = [
      `📅 *Lembrete: consulta amanhã*`,
      ``,
      `🩺 ${c.especialidade || c.profissional || 'Consulta'}`,
    ];
    if (c.profissional && c.especialidade) partes.push(`👨‍⚕️ ${c.profissional}`);
    if (c.hora) partes.push(`⏰ ${c.hora.slice(0,5)}`);
    if (c.local) partes.push(`📍 ${c.local}`);
    await enviarTexto(user.phone, partes.join('\n'));
  }

  // Retornos médicos pra próximos 7 dias (avisa só uma vez quando faltar exatamente 7d)
  const { data: retornos } = await supabase
    .from('consultas').select('id, user_id, especialidade, profissional, retorno_data')
    .not('retorno_data', 'is', null).eq('retorno_data', em7dStr);

  for (const r of retornos || []) {
    const { data: user } = await supabase.from('users').select('phone').eq('id', r.user_id).single();
    if (!user?.phone) continue;
    await enviarTexto(user.phone,
      `📆 *Retorno em 7 dias*\n\nSeu retorno com ${r.especialidade || r.profissional || 'profissional'} é em uma semana.\nQuer agendar pelo painel?`);
  }
  console.log('✅ Lembretes de consultas processados.');
});

// ─────────────────────────────────────────────────────────────────
// JOB 1E — Todo dia às 09:00: lembretes de dívidas
// Avisa 3 dias antes, no dia, e quando atrasado
// ─────────────────────────────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  console.log('🔔 Processando lembretes de dívidas...');
  const hoje = new Date();
  const hojeStr = hoje.toISOString().slice(0, 10);
  const diaHoje = hoje.getDate();

  // Busca todas as dívidas ativas com lembrete ligado e dia_vencimento definido
  const { data: dividas } = await supabase
    .from('dividas')
    .select('id, grupo_id, titulo, credor, valor_parcela, parcelas_total, parcelas_pagas, dia_vencimento, ultimo_lembrete_em')
    .in('status', ['ativa', 'em_atraso'])
    .eq('lembretes_ativos', true)
    .not('dia_vencimento', 'is', null);

  for (const d of dividas || []) {
    // Não envia duas vezes no mesmo dia
    if (d.ultimo_lembrete_em === hojeStr) continue;

    // Calcula próximo vencimento
    const venc = new Date(hoje.getFullYear(), hoje.getMonth(), d.dia_vencimento);
    if (d.dia_vencimento < diaHoje) venc.setMonth(venc.getMonth() + 1);
    const diffDias = Math.round((venc - new Date(hoje.getFullYear(), hoje.getMonth(), diaHoje)) / 86400000);

    // Janelas: 3 dias antes, no dia, ou atrasada (>=1 dia depois do venc do mês passado)
    let mensagem = null;
    if (diffDias === 3) {
      mensagem = `🔔 *Lembrete de dívida*\n\n📌 *${d.titulo}*${d.credor ? ` (${d.credor})` : ''}\n💵 ${d.valor_parcela ? `R$ ${d.valor_parcela.toFixed(2)}` : ''}\n📅 Vence em *3 dias* (dia ${d.dia_vencimento})\n\nPara pagar: *pagar divida ${d.titulo} ${d.valor_parcela?.toFixed(2) || ''}*\nPra parar de receber: *cancelar lembrete divida ${d.titulo}*`;
    } else if (diffDias === 0) {
      mensagem = `🚨 *VENCE HOJE*\n\n📌 *${d.titulo}*${d.credor ? ` (${d.credor})` : ''}\n💵 ${d.valor_parcela ? `R$ ${d.valor_parcela.toFixed(2)}` : 'sem valor de parcela'}\n\nNão esqueça! Para pagar: *pagar divida ${d.titulo} ${d.valor_parcela?.toFixed(2) || ''}*`;
    } else {
      // Atrasada: vencimento foi no mês anterior (diffDias > 25 significa que rolou pro proximo mes)
      // Detecta atraso: se o vencimento ESTE mes já passou e nao houve pagamento desde entao
      const vencEsteMes = new Date(hoje.getFullYear(), hoje.getMonth(), d.dia_vencimento);
      const diasAtraso = Math.round((new Date(hoje.getFullYear(), hoje.getMonth(), diaHoje) - vencEsteMes) / 86400000);
      if (diasAtraso > 0 && diasAtraso <= 30) {
        // Confere se houve pagamento DESDE o vencimento
        const { data: pagto } = await supabase.from('divida_pagamentos')
          .select('id').eq('divida_id', d.id)
          .gte('data_pagamento', vencEsteMes.toISOString().slice(0, 10))
          .limit(1);
        if (!pagto?.length) {
          // Avisa só uma vez por semana
          if (diasAtraso === 1 || diasAtraso === 7 || diasAtraso === 15 || diasAtraso === 30) {
            mensagem = `⚠️ *DÍVIDA EM ATRASO*\n\n📌 *${d.titulo}*\n📅 Vencimento era dia ${d.dia_vencimento} (${diasAtraso} dia${diasAtraso > 1 ? 's' : ''} atrás)\n💵 ${d.valor_parcela ? `R$ ${d.valor_parcela.toFixed(2)}` : ''}\n\nO atraso costuma vir com juros — quanto antes melhor.`;
            // Marca status em_atraso
            await supabase.from('dividas').update({ status: 'em_atraso' }).eq('id', d.id);
          }
        }
      }
    }

    if (!mensagem) continue;

    // Busca o telefone do dono e checa se ele tem lembretes_dividas ligado
    const { data: grupo } = await supabase.from('grupos').select('dono_id').eq('id', d.grupo_id).single();
    if (!grupo) continue;
    const { data: user } = await supabase.from('users').select('phone, lembretes_dividas').eq('id', grupo.dono_id).single();
    if (!user?.phone || user.lembretes_dividas === false) continue;

    await enviarTexto(user.phone, mensagem);
    await supabase.from('dividas').update({ ultimo_lembrete_em: hojeStr }).eq('id', d.id);
  }
  console.log('✅ Lembretes de dívidas processados.');
});

// ─────────────────────────────────────────────────────────────────
// JOB 2 — Todo dia 1º às 00:01: reseta alertas de limite
// ─────────────────────────────────────────────────────────────────
cron.schedule('1 0 1 * *', async () => {
  console.log('🔄 Resetando alertas de limite do mês anterior...');
  const mesAnterior = new Date();
  mesAnterior.setMonth(mesAnterior.getMonth() - 1);
  const mesRef = mesAnterior.toISOString().slice(0,7);

  await supabase.from('category_limits')
    .update({ alerta_enviado: false })
    .eq('mes_referencia', mesRef);

  console.log('✅ Alertas resetados.');
});

// ─────────────────────────────────────────────────────────────────
// JOB 3 — Todo dia às 03:00: atualiza preços via Yahoo Finance
// ─────────────────────────────────────────────────────────────────
cron.schedule('0 3 * * *', async () => {
  console.log('📈 Atualizando investimentos via Yahoo Finance...');

  const { data: invs } = await supabase
    .from('investimentos')
    .select('*')
    .not('ticker', 'is', null);

  let atualizados = 0;
  for (const inv of invs || []) {
    try {
      const quote = await yahooFinance.quote(inv.ticker);
      const precoAtual  = quote.regularMarketPrice;
      const novoValor   = precoAtual * inv.quantidade;

      // Busca dividendos desde a data de compra
      let dividendos = inv.dividendos_acumulados || 0;
      try {
        const hist = await yahooFinance.historical(inv.ticker, {
          period1: inv.data_compra, events: 'dividends'
        });
        dividendos = (hist || []).reduce((s, h) => s + (h.dividends || 0), 0) * inv.quantidade;
      } catch { /* sem dividendos para esse ativo */ }

      const rentabilidade = inv.valor_aportado > 0
        ? ((novoValor + dividendos - inv.valor_aportado) / inv.valor_aportado)
        : 0;

      await supabase.from('investimentos').update({
        valor_atual:          novoValor,
        dividendos_acumulados: dividendos,
        rentabilidade,
        ultima_atualizacao:   new Date().toISOString()
      }).eq('id', inv.id);

      // Salva snapshot histórico
      await supabase.from('historico_investimentos').insert({
        grupo_id:        inv.grupo_id,
        investimento_id: inv.id,
        valor_atual:     novoValor
      });

      atualizados++;
      // Aguarda 1s entre requisições (rate limit do Yahoo)
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      console.error(`❌ Erro ao atualizar ${inv.ticker}:`, err.message);
    }
  }
  console.log(`✅ ${atualizados} investimentos atualizados.`);
});

// ─────────────────────────────────────────────────────────────────
// JOB 4 — Todo dia às 23:59: snapshot do patrimônio total
// ─────────────────────────────────────────────────────────────────
cron.schedule('59 23 * * *', async () => {
  console.log('💰 Salvando snapshot de patrimônio...');

  // Busca grupos com plano Black
  const { data: users } = await supabase
    .from('users')
    .select('grupo_ativo')
    .eq('plano', 'black')
    .not('grupo_ativo', 'is', null);

  const gruposVistos = new Set();
  for (const u of users || []) {
    if (gruposVistos.has(u.grupo_ativo)) continue;
    gruposVistos.add(u.grupo_ativo);

    const { data: invs } = await supabase.from('investimentos')
      .select('valor_atual').eq('grupo_id', u.grupo_ativo);
    const { data: wallets } = await supabase.from('wallets')
      .select('saldo').eq('grupo_id', u.grupo_ativo);

    const totalInv     = (invs    || []).reduce((s,i) => s + i.valor_atual, 0);
    const totalWallets = (wallets || []).reduce((s,w) => s + w.saldo, 0);
    const patrimonioTotal = totalInv + totalWallets;

    // Busca patrimônio do dia anterior para calcular rentabilidade
    const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
    const { data: anterior } = await supabase.from('patrimonio_historico')
      .select('patrimonio_total')
      .eq('grupo_id', u.grupo_ativo)
      .gte('data', ontem.toISOString())
      .order('data', { ascending: false })
      .limit(1)
      .single();

    const rentabilidade = anterior?.patrimonio_total > 0
      ? ((patrimonioTotal - anterior.patrimonio_total) / anterior.patrimonio_total) * 100
      : 0;

    await supabase.from('patrimonio_historico').insert({
      grupo_id:             u.grupo_ativo,
      patrimonio_total:     patrimonioTotal,
      rentabilidade_periodo: rentabilidade
    });
  }
  console.log('✅ Snapshots salvos.');
});

// ─────────────────────────────────────────────────────────────────
// JOB — Snapshot de DRE diário (00h05) para usuários com integrações ativas
// ─────────────────────────────────────────────────────────────────
const { gerarDre } = require('../handlers/negocios');
const { gerarInsights } = require('../handlers/insights-negocio');
cron.schedule('5 0 * * *', async () => {
  console.log('📊 Gerando snapshots de DRE + insights...');
  const periodoAtual    = new Date().toISOString().slice(0, 7) + '-01';
  const dAnterior = new Date(); dAnterior.setMonth(dAnterior.getMonth() - 1);
  const periodoAnterior = dAnterior.toISOString().slice(0, 7) + '-01';

  const { data: integ } = await supabase
    .from('integracoes').select('user_id, grupo_id').eq('status', 'ativa');

  const usersUnicos = Array.from(new Map((integ || []).map(i => [i.user_id, i])).values());
  let okSnap = 0, okIns = 0;
  for (const u of usersUnicos) {
    try {
      await supabase.from('dre_snapshots').delete().eq('user_id', u.user_id).eq('periodo', periodoAtual);
      await gerarDre(u.user_id, u.grupo_id, periodoAtual);
      await supabase.from('dre_snapshots').delete().eq('user_id', u.user_id).eq('periodo', periodoAnterior);
      await gerarDre(u.user_id, u.grupo_id, periodoAnterior);
      okSnap++;
      const ins = await gerarInsights(u.user_id, u.grupo_id);
      okIns += ins.length;
    } catch (e) {
      console.error('[dre/insights] erro user', u.user_id, e.message);
    }
  }
  console.log(`✅ DRE: ${okSnap} users · Insights: ${okIns} gerados.`);
});

console.log('⏰ Cron jobs registrados:');
console.log('   • A cada hora  — recorrências, lembretes, parcelas, fatura');
console.log('   • A cada 15min — lembretes de medicamentos');
console.log('   • Todo dia 09h — lembretes de consultas (24h antes + retorno 7d)');
console.log('   • Todo dia 09h — lembretes de dívidas (3d antes / dia / atraso)');
console.log('   • Todo dia 1º  — reset de alertas de limite');
console.log('   • Todo dia 03h — atualização Yahoo Finance');
console.log('   • Todo dia 23h59 — snapshot de patrimônio');
console.log('   • Todo dia 00h05 — snapshot de DRE Negócios');