const supabase = require('../db/supabase');
const { enviarTexto, enviarMenu } = require('../services/zapi');
const { analisarGastos } = require('../services/ia');
const { criarPendente } = require('../services/pendentes');

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

// Busca a wallet padrão do user (se definida)
async function buscarWalletPadrao(userId) {
  if (!userId) return null;
  const { data: u } = await supabase
    .from('users')
    .select('wallet_padrao_id, wallets!users_wallet_padrao_id_fkey(id, nome)')
    .eq('id', userId)
    .single();
  return u?.wallets?.nome || null;
}

// Normaliza texto pra match: lowercase, sem acento
function normTxt(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Testa se `trecho` aparece como palavra inteira em `texto`
function temPalavra(texto, trecho) {
  const esc = trecho.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${esc}(\\s|$)`).test(texto);
}

// Refina a categoria usando as categorias/subcategorias REAIS do grupo.
// Ex: usuário tem subcategoria "Shein" → "gastei 290 na shein" vira Shein.
// Prioriza subcategorias e nomes mais longos (mais específicos).
async function refinarCategoria(grupoId, texto) {
  const t = normTxt(texto);
  if (!t) return null;
  const { data: cats } = await supabase.from('categorias')
    .select('nome, parent_id').eq('grupo_id', grupoId);
  if (!cats?.length) return null;
  const ordenadas = [...cats].sort((a, b) => {
    const espec = (b.parent_id ? 1 : 0) - (a.parent_id ? 1 : 0);
    return espec !== 0 ? espec : b.nome.length - a.nome.length;
  });
  for (const c of ordenadas) {
    const nome = normTxt(c.nome);
    if (!nome || nome === 'outros') continue;
    if (temPalavra(t, nome)) return c.nome;
  }
  return null;
}

// Detecta se o usuário citou uma conta existente no texto da mensagem.
// Ex: "gastei 290 na shein nubank" → conta "Nubank" (mais longo primeiro
// pra "Nubank Crédito" ganhar de "Nubank" quando aplicável).
async function detectarContaNoTexto(grupoId, texto) {
  const t = normTxt(texto);
  if (!t) return null;
  const contas = await listarContasAtivas(grupoId);
  const ord = [...contas].sort((a, b) => b.nome.length - a.nome.length);
  for (const c of ord) {
    if (temPalavra(t, normTxt(c.nome))) return c.nome;
  }
  return null;
}

// Lista as contas ATIVAS do grupo (pra perguntar de qual saiu a transação)
// Não filtra por `arquivada` na query (coluna pode não existir no schema) —
// filtra em JS de forma defensiva.
async function listarContasAtivas(grupoId) {
  if (!grupoId) return [];
  const { data, error } = await supabase
    .from('wallets')
    .select('id, nome, tipo, arquivada')
    .eq('grupo_id', grupoId)
    .order('created_at', { ascending: true });
  if (error) {
    // Fallback: schema sem coluna arquivada → busca sem ela
    const { data: d2 } = await supabase
      .from('wallets')
      .select('id, nome, tipo')
      .eq('grupo_id', grupoId)
      .order('created_at', { ascending: true });
    return d2 || [];
  }
  return (data || []).filter(w => !w.arquivada);
}

// ── HANDLER PRINCIPAL ─────────────────────────────────────────────
module.exports = async function handleTransacoes(data, ctx) {
  const { phone, grupoId, user } = ctx;

  // ── SALVAR ──────────────────────────────────────────────────────
  if (data.acao === 'salvar') {
    const valor = parseFloat(data.valor);
    const idCurto = gerarId();

    // Refina categoria pelas categorias/subcategorias reais do grupo
    // (ex: subcategoria "Shein"). Só sobrescreve se achar algo melhor que Outros.
    const catRefinada = await refinarCategoria(grupoId, ctx.mensagem || data.observacao);
    if (catRefinada) data.categoria = catRefinada;

    // Estratégia de escolha de carteira:
    //   1) Se a mensagem cita banco → usa esse
    //   2) Se user tem wallet_padrao → usa esse
    //   3) Se user só tem 1 conta cadastrada → usa essa (e marca como padrão!)
    //   4) Se user não tem contas → cria 'Dinheiro' automaticamente
    //   5) Múltiplas contas, sem padrão → PERGUNTA via menu interativo
    let carteiraNome   = data.carteira_nome;
    let precisaPerguntar = false;
    let contasAtivas   = [];

    if (!carteiraNome) {
      // Caso 1: conta citada no texto (ex: "...na shein nubank" → Nubank)
      carteiraNome = await detectarContaNoTexto(grupoId, ctx.mensagem);

      // Caso 2: wallet padrão do usuário
      if (!carteiraNome) carteiraNome = await buscarWalletPadrao(user?.id);

      if (!carteiraNome) {
        contasAtivas = await listarContasAtivas(grupoId);

        if (contasAtivas.length === 1) {
          // Caso 3: auto-elege a única conta como principal
          carteiraNome = contasAtivas[0].nome;
          if (user?.id) {
            await supabase.from('users')
              .update({ wallet_padrao_id: contasAtivas[0].id })
              .eq('id', user.id);
          }
        } else if (contasAtivas.length === 0) {
          // Caso 4: sem contas — registra em "Dinheiro" e orienta criar
          carteiraNome = 'Dinheiro';
        } else {
          // Caso 5: múltiplas, sem padrão — vai PERGUNTAR depois de salvar
          precisaPerguntar = true;
          // Salva temporariamente em "Dinheiro" — será movido após escolha
          carteiraNome = 'Dinheiro';
        }
      }
    }

    // Salva a transação (mesmo se precisaPerguntar, registramos pra ter id)
    const { data: txCriada } = await supabase.from('transacoes').insert({
      id_curto:     idCurto,
      grupo_id:     grupoId,
      tipo:         data.tipo,
      categoria:    data.categoria || 'Outros',
      valor,
      observacao:   data.observacao || '',
      carteira_nome: carteiraNome,
      pago:         true,
      data:         new Date().toISOString()
    }).select().single();

    // Atualiza saldo da carteira (mesmo a temporária)
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

    // ── CASO 4: sem contas — orienta criar ────────────────────────
    if (carteiraNome === 'Dinheiro' && !precisaPerguntar && contasAtivas.length === 0) {
      const msg =
        `✅ Anotei R$ ${valor.toFixed(2)} em ${data.categoria || 'Outros'}.\n\n` +
        `⚠️ Você ainda não tem contas cadastradas, então registrei em *Dinheiro*.\n\n` +
        `🏦 *Crie suas contas* pra eu organizar direito.\n` +
        `Recomendo criar pelo painel onde dá pra escolher o tipo (corrente, poupança, crédito):\n` +
        `👉 forsora.com/contas-bancarias\n\n` +
        `Ou me manda o nome + saldo:\n` +
        `Ex: \`nubank 1000\` → Nubank Corrente com R$ 1.000\n` +
        `Ex: \`nubank crédito 5000\` → Nubank Crédito com limite R$ 5.000`;
      await enviarTexto(phone, msg);
      // Cria pendente pra próxima mensagem (se for "nubank 1000", o handler cria a conta)
      if (user?.id) {
        await criarPendente({
          userId: user.id,
          tipoPergunta: 'criar_conta',
          contexto: { transacao_id: txCriada?.id, id_curto: idCurto },
          transacaoId: txCriada?.id,
        });
      }
      return;
    }

    // ── CASO 5: múltiplas contas, sem padrão — PERGUNTA ─────────
    if (precisaPerguntar && contasAtivas.length > 1) {
      const opcoesTexto = contasAtivas
        .map((c, i) => `${i + 1}️⃣ ${c.nome}`)
        .join('\n');

      const msg =
        `✅ Anotei R$ ${valor.toFixed(2)} em ${data.categoria || 'Outros'}.\n\n` +
        `❓ *De qual conta saiu?*\n${opcoesTexto}\n\n` +
        `Responde com o número ou o nome.`;
      await enviarTexto(phone, msg);

      // Salva pendente pra próxima mensagem resolver
      if (user?.id) {
        await criarPendente({
          userId: user.id,
          tipoPergunta: 'escolher_conta',
          contexto: {
            transacao_id: txCriada?.id,
            id_curto: idCurto,
            valor,
            opcoes: contasAtivas.map((c) => ({ id: c.id, nome: c.nome })),
            carteira_temp: carteiraNome, // 'Dinheiro' — pra reverter saldo
          },
          transacaoId: txCriada?.id,
        });
      }
      return;
    }

    // ── CASO PADRÃO: tudo normal ──────────────────────────────────
    const msg =
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

  // ── CORRIGIR ÚLTIMA CARTEIRA ────────────────────────────────────
  // Usado quando o usuário fala "não, foi do nubank" depois de criar
  // uma transação na conta padrão. Move a última transação (criada
  // pelo user nas últimas 24h) pra carteira correta e reajusta saldos.
  if (data.acao === 'corrigir_ultima_carteira') {
    const novaCarteira = data.carteira_nome;
    if (!novaCarteira) {
      await enviarTexto(phone, '❌ Não entendi pra qual conta corrigir. Tenta: "última foi do nubank"');
      return;
    }

    // Última transação do user (criada nas últimas 24h)
    const limite24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: rows } = await supabase
      .from('transacoes')
      .select('*')
      .eq('grupo_id', grupoId)
      .gte('created_at', limite24h)
      .order('created_at', { ascending: false })
      .limit(1);
    const tx = rows?.[0];

    if (!tx) {
      await enviarTexto(phone, '❌ Não achei nenhuma transação recente pra corrigir.');
      return;
    }

    // Se já está na carteira certa, só responde
    if ((tx.carteira_nome || '').toLowerCase() === novaCarteira.toLowerCase()) {
      await enviarTexto(phone, `ℹ️ Essa transação já está em *${tx.carteira_nome}*.`);
      return;
    }

    const mult = tx.tipo === 'Gasto' ? -1 : 1;

    // Reverte saldo da carteira antiga
    const { data: walletAntiga } = await supabase
      .from('wallets').select('id, saldo')
      .eq('grupo_id', grupoId).ilike('nome', tx.carteira_nome).single();
    if (walletAntiga) {
      await supabase.from('wallets')
        .update({ saldo: walletAntiga.saldo - (tx.valor * mult) })
        .eq('id', walletAntiga.id);
    }

    // Aplica saldo na carteira nova
    const { data: walletNova } = await supabase
      .from('wallets').select('id, saldo')
      .eq('grupo_id', grupoId).ilike('nome', novaCarteira).single();
    if (walletNova) {
      await supabase.from('wallets')
        .update({ saldo: walletNova.saldo + (tx.valor * mult) })
        .eq('id', walletNova.id);
    } else {
      // Carteira não existe — cria automaticamente
      await supabase.from('wallets').upsert({
        grupo_id: grupoId,
        nome:     novaCarteira,
        tipo:     novaCarteira.toLowerCase().includes('crédito') ? 'Crédito' : 'Corrente',
        saldo:    tx.valor * mult,
      }, { onConflict: 'grupo_id,nome' });
    }

    // Atualiza a transação
    await supabase.from('transacoes')
      .update({ carteira_nome: novaCarteira })
      .eq('id', tx.id);

    await enviarTexto(phone,
      `✅ Atualizei! Última transação (*${tx.id_curto}*) agora está em *${novaCarteira}*.\n` +
      `💸 R$ ${tx.valor.toFixed(2)} — ${tx.observacao || tx.categoria}`
    );
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