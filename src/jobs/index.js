const cron      = require('node-cron');
const supabase  = require('../db/supabase');
const { enviarTexto } = require('../services/zapi');
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

  // ── 1D. FATURA DO CARTÃO ────────────────────────────────────────
  const { data: users } = await supabase
    .from('users')
    .select('phone, dia_fechamento_fatura, ultimo_fechamento, grupo_ativo')
    .eq('dia_fechamento_fatura', diaHoje)
    .not('grupo_ativo', 'is', null);

  for (const u of users || []) {
    const ultimoFech = u.ultimo_fechamento ? new Date(u.ultimo_fechamento) : null;
    // Evita enviar mais de uma vez no mesmo dia
    if (ultimoFech && ultimoFech.toDateString() === hoje.toDateString()) continue;

    const inicio = ultimoFech || new Date(hoje.getFullYear(), hoje.getMonth() - 1, diaHoje);
    const { data: parcsFatura } = await supabase.from('parcelas')
      .select('valor_parcela')
      .eq('grupo_id', u.grupo_ativo)
      .eq('ativa', true)
      .gte('data_proxima_vencimento', inicio.toISOString())
      .lte('data_proxima_vencimento', fimHoje.toISOString());

    const totalFatura = (parcsFatura || []).reduce((s, p) => s + p.valor_parcela, 0);
    if (totalFatura > 0 && u.phone) {
      await enviarTexto(u.phone,
        `💳 *FATURA DO CARTÃO*\n` +
        `Período: ${inicio.toLocaleDateString('pt-BR')} a ${hoje.toLocaleDateString('pt-BR')}\n` +
        `💵 Total: R$ ${totalFatura.toFixed(2)}\n\n` +
        `Para pagar: "transferir ${totalFatura.toFixed(2)} do [sua conta] para [cartão]"`
      );
      await supabase.from('users').update({ ultimo_fechamento: hoje.toISOString() }).eq('phone', u.phone);
    }
  }
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

console.log('⏰ Cron jobs registrados:');
console.log('   • A cada hora  — recorrências, lembretes, parcelas, fatura');
console.log('   • Todo dia 1º  — reset de alertas de limite');
console.log('   • Todo dia 03h — atualização Yahoo Finance');
console.log('   • Todo dia 23h59 — snapshot de patrimônio');