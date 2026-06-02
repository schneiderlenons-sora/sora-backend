const supabase = require('../db/supabase');
const { enviarTexto, enviarMenu } = require('../services/zapi');
const { analisarGastos } = require('../services/ia');
const { criarPendente } = require('../services/pendentes');

// Mapa de emoji por categoria/subcategoria (chave normalizada: sem emoji, sem acento, lowercase)
const EMOJIS_MAP = {
  // Categorias principais
  'mercado':'🛒', 'supermercado':'🛒',
  'transporte':'🚗',
  'alimentacao':'🍽️', 'alimentação':'🍽️', 'restaurante':'🍽️',
  'lazer e entretenimento':'🎬', 'lazer':'🎬',
  'saude':'💊', 'saúde':'💊',
  'aluguel':'🏠', 'moradia':'🏠',
  'educacao':'📚', 'educação':'📚',
  'casa':'🏠',
  'salario':'💰', 'salário':'💰',
  'recebimento':'💰',
  'transferencias':'🔄', 'transferências':'🔄',
  'internet':'🛜',
  'pet':'🐶',
  'padaria':'🥖',
  'assinaturas':'📺',
  'vestuario':'👕', 'vestuário':'👕',
  'impostos':'📉',
  'viagem':'✈️',
  'doacoes':'🏷️', 'doações':'🏷️',
  'outros':'📦',
  'escola':'🎒',
  'encomendas':'📦',
  // Subcategorias de transporte
  'uber':'🚗', '99':'🚗', 'cabify':'🚗',
  // Subcategorias de alimentação / delivery
  'ifood':'🍔', 'i food':'🍔',
  'rappi':'🛵',
  // Subcategorias de streaming / assinaturas
  'netflix':'🎬', 'spotify':'🎵', 'disney+':'🎬', 'disney plus':'🎬',
  'prime video':'📺', 'hbo max':'📺', 'hbo':'📺',
  'globo play':'📺', 'globoplay':'📺',
  'youtube premium':'▶️', 'youtube':'▶️',
  'deezer':'🎵', 'apple music':'🎵',
  // Subcategorias de vestuário/moda
  'nike':'👟', 'adidas':'👟', 'puma':'👟', 'new balance':'👟',
  'shein':'👗', 'zara':'👗', 'riachuelo':'👗', 'renner':'👗', 'cea':'👗',
  'reserva':'👔',
  // Subcategorias de encomendas / marketplaces
  'amazon':'📦', 'shopee':'📦', 'mercado livre':'📦',
  'aliexpress':'📦', 'tiktok shop':'📦', 'magalu':'📦',
  // Subcategorias de saúde
  'farmacia':'💊', 'farmácia':'💊', 'drogaria':'💊',
  // Subcategorias de educação
  'udemy':'💻', 'coursera':'💻', 'duolingo':'📱', 'alura':'💻',
  // Pagamentos
  'pix':'💸', 'ted':'💸', 'boleto':'💸',
};

// Retorna o emoji mais adequado para um nome de categoria/subcategoria.
// Normaliza o nome (remove emoji, acento, lowercase) e tenta match exato,
// depois substring — garante que "🚗 Transporte" e "Transporte" retornam 🚗.
function emojiDaCat(nome) {
  const limpo = (nome || '').replace(/\p{Emoji}/gu, '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  if (!limpo) return '📌';
  // Match exato
  if (EMOJIS_MAP[limpo]) return EMOJIS_MAP[limpo];
  // Match parcial (ex: "Lazer e Entretenimento" contém "lazer")
  for (const [key, emoji] of Object.entries(EMOJIS_MAP)) {
    if (limpo.includes(key) || key.includes(limpo)) return emoji;
  }
  return '📌';
}

// Gera ID curto de 6 caracteres
function gerarId() {
  return Math.random().toString(36).substring(2,8).toUpperCase();
}

// Limpa nome de categoria pra comparação: sem emoji, sem acento, lowercase
function limpaCat(s) {
  return (s || '').replace(/\p{Emoji}/gu, '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// Verifica e dispara alerta de limite (geral e por categoria).
// IMPORTANTE: gasto em subcategoria conta pro limite da categoria-pai
// (ex: gasto em "Shein" conta pro limite de "Vestuário").
// A transação JÁ está salva quando isso roda, então a soma já a inclui.
async function verificarLimite(grupoId, phone, user) {
  const mesRef = new Date().toISOString().slice(0, 7);
  // Primeiro dia do mês seguinte (limite exclusivo) — evita `${mes}-31`
  // inválido em meses de 30/28 dias.
  const [_a, _m] = mesRef.split('-').map(Number);
  const fimMes = `${new Date(_a, _m, 1).getFullYear()}-${String(new Date(_a, _m, 1).getMonth() + 1).padStart(2, '0')}-01`;

  // Gastos do mês do grupo — usado pelos dois tipos de limite
  const { data: gastos } = await supabase
    .from('transacoes').select('valor, categoria')
    .eq('grupo_id', grupoId).eq('tipo', 'Gasto')
    .gte('data', `${mesRef}-01`).lt('data', fimMes);

  // ── Limites POR CATEGORIA (subcategoria conta pro pai) ──────────
  const { data: limites } = await supabase
    .from('category_limits').select('*')
    .eq('grupo_id', grupoId).eq('mes_referencia', mesRef);

  if (limites?.length) {
    const { data: cats } = await supabase
      .from('categorias').select('id, nome, parent_id').eq('grupo_id', grupoId);

    for (const limite of limites) {
      if (limite.ativo === false || !limite.limite_mensal || limite.alerta_enviado) continue;

      const alvo = limpaCat(limite.categoria);
      const nomes = new Set([alvo]);
      const cat = (cats || []).find(c => limpaCat(c.nome) === alvo);
      if (cat) {
        (cats || []).filter(c => c.parent_id === cat.id).forEach(c => nomes.add(limpaCat(c.nome)));
      }

      const total = (gastos || [])
        .filter(g => nomes.has(limpaCat(g.categoria)))
        .reduce((s, g) => s + (g.valor || 0), 0);

      const pct = (total / limite.limite_mensal) * 100;
      if (pct >= (limite.percentual_alerta || 80)) {
        await enviarTexto(phone,
          `⚠️ *Atenção!* Você atingiu *${pct.toFixed(0)}%* do limite de *${limite.categoria}*.\n` +
          `Limite: R$ ${limite.limite_mensal.toFixed(2)} | Gasto atual: R$ ${total.toFixed(2)}`
        );
        await supabase.from('category_limits')
          .update({ alerta_enviado: true }).eq('id', limite.id);
      }
    }
  }

  // ── Limite GERAL (meta_mensal no users) ─────────────────────────
  await verificarLimiteGeral(grupoId, phone, user, mesRef, gastos || []);
}

// Alerta quando o gasto TOTAL do mês atinge o % da meta mensal.
// Usa meta_mensal_alerta_enviado (= mesRef) pra não repetir no mês.
async function verificarLimiteGeral(grupoId, phone, user, mesRef, gastos) {
  // user pode vir desatualizado — busca os campos frescos pelo grupo
  let u = user;
  if (!u || u.meta_mensal === undefined) {
    const { data } = await supabase.from('users')
      .select('meta_mensal, meta_mensal_ativo, meta_mensal_alerta_ativo, meta_mensal_alerta_pct, meta_mensal_alerta_enviado, phone')
      .eq('grupo_ativo', grupoId).limit(1).maybeSingle();
    u = data;
  }
  if (!u) return;

  const meta = u.meta_mensal || 0;
  const ativo = u.meta_mensal_ativo ?? true;
  const alertaAtivo = u.meta_mensal_alerta_ativo ?? true;
  const pctAlerta = u.meta_mensal_alerta_pct ?? 80;
  if (!meta || !ativo || !alertaAtivo) return;
  if (u.meta_mensal_alerta_enviado === mesRef) return; // já avisou este mês

  const total = (gastos || []).reduce((s, g) => s + (g.valor || 0), 0);
  const pct = (total / meta) * 100;
  if (pct < pctAlerta) return;

  await enviarTexto(phone,
    `🚨 *Limite geral!* Você atingiu *${pct.toFixed(0)}%* da sua meta de gastos do mês.\n` +
    `Meta: R$ ${meta.toFixed(2)} | Gasto total: R$ ${total.toFixed(2)}`
  );
  // Marca como avisado neste mês (defensivo: coluna pode não existir ainda)
  try {
    await supabase.from('users')
      .update({ meta_mensal_alerta_enviado: mesRef })
      .eq('phone', u.phone || phone.replace(/\D/g, ''));
  } catch (e) { console.warn('[limite geral] flag alerta:', e.message); }
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

      // Conta veio embutida no texto → remove o nome dela da observação
      // pra não ficar "shein nubank" na descrição (vira só "shein").
      if (carteiraNome && data.observacao) {
        const esc = carteiraNome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        data.observacao = data.observacao
          .replace(new RegExp(`\\b${esc}\\b`, 'gi'), '')
          .replace(/\s+/g, ' ').trim();
      }

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

    // Verifica limites — por categoria (subcategoria conta pro pai) + geral
    if (data.tipo === 'Gasto') {
      await verificarLimite(grupoId, phone, user);
    }

    const emoji = emojiDaCat(data.categoria);
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
      const emoji = emojiDaCat(r.categoria);
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
      .map(([cat, val]) => `${emojiDaCat(cat)} *${cat}:* R$ ${val.toFixed(2)}`)
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
      `🌐 https://www.forsora.com/dashboard`
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