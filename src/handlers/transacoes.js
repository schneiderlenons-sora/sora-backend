const supabase = require('../db/supabase');
const { enviarTexto, enviarMenu } = require('../services/zapi');
const { analisarGastos } = require('../services/ia');

const EMOJIS = {
  'Mercado':'🛒','Transporte':'🚗','Lazer e Entretenimento':'🍺',
  'Saúde':'💊','Aluguel':'🏠','Educação':'📚','Casa':'🏠',
  'Salário':'💰','Alimentação':'🧃','Recebimento':'💰',
  'Transferências':'🔄','Internet':'🛜','Pet':'🐶','Padaria':'🥖',
  'Assinaturas':'📺','Vestuário':'👕','Impostos':'📉',
  'Viagem':'✈️','Doações':'🏷️','Outros':'📦'
};

// Gera ID curto de 6 caracteres
function gerarId() {
  return Math.random().toString(36).substring(2,8).toUpperCase();
}

// Verifica e dispara alerta de limite de categoria
async function verificarLimite(grupoId, categoria, valorNovo, phone) {
  const mesRef = new Date().toISOString().slice(0,7);

  // Soma gastos do mês nessa categoria
  const { data: gastos } = await supabase
    .from('transacoes')
    .select('valor')
    .eq('grupo_id', grupoId)
    .eq('tipo', 'Gasto')
    .eq('categoria', categoria)
    .gte('data', `${mesRef}-01`);

  const totalAtual = (gastos || []).reduce((s, g) => s + g.valor, 0);
  const novoTotal  = totalAtual + valorNovo;

  const { data: limite } = await supabase
    .from('category_limits')
    .select('*')
    .eq('grupo_id', grupoId)
    .eq('categoria', categoria)
    .eq('mes_referencia', mesRef)
    .single();

  if (limite && limite.limite_mensal > 0) {
    const pct = (novoTotal / limite.limite_mensal) * 100;
    if (pct >= limite.percentual_alerta && !limite.alerta_enviado) {
      await enviarTexto(phone,
        `⚠️ *Atenção!* Você atingiu *${pct.toFixed(0)}%* do limite de *${categoria}*.\n` +
        `Limite: R$ ${limite.limite_mensal.toFixed(2)} | Gasto atual: R$ ${novoTotal.toFixed(2)}`
      );
      await supabase.from('category_limits')
        .update({ alerta_enviado: true })
        .eq('id', limite.id);
    }
  }
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────
module.exports = async function handleTransacoes(data, ctx) {
  const { phone, grupoId, user } = ctx;

  // ── SALVAR ──────────────────────────────────────────────────────
  if (data.acao === 'salvar') {
    const valor        = parseFloat(data.valor);
    const carteiraNome = data.carteira_nome || 'Dinheiro';
    const idCurto      = gerarId();

    // Salva a transação
    await supabase.from('transacoes').insert({
      id_curto:     idCurto,
      grupo_id:     grupoId,
      tipo:         data.tipo,
      categoria:    data.categoria || 'Outros',
      valor,
      observacao:   data.observacao || '',
      carteira_nome: carteiraNome,
      pago:         true,
      data:         new Date().toISOString()
    });

    // Atualiza saldo da carteira
    const mult = data.tipo === 'Gasto' ? -1 : 1;
    const { data: wallet } = await supabase
      .from('wallets')
      .select('id, saldo')
      .eq('grupo_id', grupoId)
      .ilike('nome', carteiraNome)
      .single();

    if (wallet) {
      await supabase.from('wallets')
        .update({ saldo: wallet.saldo + (valor * mult) })
        .eq('id', wallet.id);
    } else if (carteiraNome === 'Dinheiro') {
      // Cria carteira Dinheiro automaticamente se não existir
      await supabase.from('wallets').upsert({
        grupo_id: grupoId, nome: 'Dinheiro', tipo: 'Dinheiro',
        saldo: valor * mult
      }, { onConflict: 'grupo_id,nome' });
    }

    // Verifica limite se for gasto
    if (data.tipo === 'Gasto') {
      await verificarLimite(grupoId, data.categoria, valor, phone);
    }

    const emoji = EMOJIS[data.categoria] || '🔖';
    const tipo  = data.tipo === 'Gasto' ? '🟥 Despesa' : '🟩 Receita';
    const msg   =
      `✅ *Transação registrada!*\n\n` +
      `🔑 ID: \`${idCurto}\`\n` +
      `${emoji} Categoria: ${data.categoria}\n` +
      `💸 Valor: R$ ${valor.toFixed(2)}\n` +
      `🔄 Tipo: ${tipo}\n` +
      `🏦 Conta: ${carteiraNome}\n\n` +
      `❌ Para desfazer: *excluir transação ${idCurto}*`;

    await enviarMenu(phone, msg);
    return;
  }

  // ── APAGAR ──────────────────────────────────────────────────────
  if (data.acao === 'apagar') {
    let query = supabase.from('transacoes').select('*').eq('grupo_id', grupoId);

    if (data.idCurto) {
      query = query.eq('id_curto', data.idCurto);
    } else {
      query = query.order('created_at', { ascending: false }).limit(1);
    }

    const { data: rows } = await query;
    const tx = rows?.[0];

    if (!tx) {
      await enviarTexto(phone, '❌ Transação não encontrada.');
      return;
    }

    // Reverte o saldo da carteira
    const mult = tx.tipo === 'Gasto' ? 1 : -1;
    const { data: wallet } = await supabase
      .from('wallets').select('id, saldo')
      .eq('grupo_id', grupoId).ilike('nome', tx.carteira_nome).single();

    if (wallet) {
      await supabase.from('wallets')
        .update({ saldo: wallet.saldo + (tx.valor * mult) })
        .eq('id', wallet.id);
    }

    await supabase.from('transacoes').delete().eq('id', tx.id);
    await enviarTexto(phone, `🗑️ Transação *${tx.id_curto}* removida. Saldo ajustado.`);
    return;
  }

  // ── BUSCAR ──────────────────────────────────────────────────────
  if (data.acao === 'buscar') {
    let query = supabase.from('transacoes')
      .select('*').eq('grupo_id', grupoId)
      .eq('tipo', 'Gasto').order('data', { ascending: false }).limit(30);

    if (data.termo && data.termo !== 'TUDO') {
      query = query.or(`categoria.ilike.%${data.termo}%,observacao.ilike.%${data.termo}%`);
    }

    const { data: rows } = await query;
    if (!rows?.length) {
      await enviarTexto(phone, `🔍 Nenhum gasto encontrado para *"${data.termo}"*.`);
      return;
    }

    let total = 0;
    const lista = rows.map(r => {
      total += r.valor;
      const dt = new Date(r.data).toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit' });
      const emoji = EMOJIS[r.categoria] || '📅';
      return `${emoji} ${dt} - R$ ${r.valor.toFixed(2)} (${r.categoria})`;
    }).join('\n');

    await enviarTexto(phone,
      `🔍 *Busca: ${data.termo}*\n\n${lista}\n\n💰 *Total: R$ ${total.toFixed(2)}*`
    );
    return;
  }

  // ── RESUMO ──────────────────────────────────────────────────────
  if (data.acao === 'resumo') {
    const inicioMes = new Date();
    inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);

    const { data: rows } = await supabase
      .from('transacoes').select('tipo, categoria, valor')
      .eq('grupo_id', grupoId)
      .gte('data', inicioMes.toISOString());

    let gastos = 0, receitas = 0;
    const cats = {};
    (rows || []).forEach(r => {
      if (r.tipo === 'Gasto') {
        gastos += r.valor;
        cats[r.categoria] = (cats[r.categoria] || 0) + r.valor;
      } else {
        receitas += r.valor;
      }
    });

    const catOrdenadas = Object.entries(cats)
      .sort((a,b) => b[1]-a[1])
      .map(([cat, val]) => `${EMOJIS[cat]||'🔹'} *${cat}:* R$ ${val.toFixed(2)}`)
      .join('\n') || 'Sem gastos ainda.';

    const saldo = receitas - gastos;
    const metaMensal = user.meta_mensal || 0;
    const statusMeta = metaMensal > 0
      ? `\n🎯 Meta: R$ ${metaMensal.toFixed(2)} (${((gastos/metaMensal)*100).toFixed(0)}% usado)`
      : '';

    await enviarTexto(phone,
      `📊 *RESUMO DO MÊS*\n\n${catOrdenadas}\n\n` +
      `🔴 Gastos: R$ ${gastos.toFixed(2)}\n` +
      `🟢 Receitas: R$ ${receitas.toFixed(2)}\n` +
      `💰 *Saldo: R$ ${saldo.toFixed(2)}*${statusMeta}\n\n` +
      `🌐 ${process.env.PAINEL_URL}?phone=${phone}`
    );
    return;
  }

  // ── ANALISAR ────────────────────────────────────────────────────
  if (data.acao === 'analisar') {
    const semanaAtras = new Date();
    semanaAtras.setDate(semanaAtras.getDate() - 7);

    const { data: rows } = await supabase
      .from('transacoes').select('categoria, valor')
      .eq('grupo_id', grupoId).eq('tipo', 'Gasto')
      .gte('data', semanaAtras.toISOString());

    if (!rows?.length) {
      await enviarTexto(phone, '📭 Sem gastos na última semana para analisar.');
      return;
    }

    const resumo = rows.map(r => `${r.categoria}: R$ ${r.valor.toFixed(2)}`).join(', ');
    const analise = await analisarGastos(resumo);
    await enviarTexto(phone, `🧠 *Análise da semana:*\n\n${analise}`);
    return;
  }
};