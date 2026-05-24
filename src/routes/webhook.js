const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const { enviarTexto, enviarMenu } = require('../services/zapi');
const { interpretarMensagem, classificarIntencao } = require('../services/ia');
const { transcreverAudio }        = require('../services/whisper');
const { interpretarRapido }       = require('../handlers/interpretador');

// Verifica acesso ao Grow
function temAcessoGrow(user) {
  if (!user) return false;
  if (user.plano === 'black') return true;
  if (['grow_basico','grow_premium'].includes(user.plano_grow)) return true;
  if (user.plano_grow === 'trial' && user.grow_trial_fim && new Date(user.grow_trial_fim) > new Date()) return true;
  return false;
}

// Textos fixos
const HELP_TEXT = `━━━━━━━━━━
💸 *Lançamentos rápidos*
Me mande texto ou áudio — eu entendo automaticamente 😉

💰 *Receita:* "recebi 2000 de salário"
💸 *Gasto:*   "gastei 50 no mercado"

━━━━━━━━━━
🏦 *Contas*
"nubank 1000" → cria conta
"saldo" → ver todos os saldos
"transferir 200 do nubank pro inter"

💳 *Parcelado*
"comprei fone no nubank crédito em 3x de 150"

🔁 *Conta fixa*
"todo mês 1000 aluguel dia 5"

━━━━━━━━━━
💳 *Dívidas*
"criar divida emprestimo nubank 5000 em 10x dia 15"
"minhas dividas" → lista tudo
"pagar divida nubank 250"
"quitar divida nubank"
"cancelar lembrete divida nubank" (ou só "cancelar lembrete dividas" pra parar todos)

━━━━━━━━━━
📊 "resumo" → relatório do mês
🎯 "limite 2000" → meta de gastos
🔔 "limite mercado 500" → limite por categoria
🧠 "analisar" → análise da semana
🌐 "painel" → abrir painel web
━━━━━━━━━━`;

const WELCOME_TEXT = (nome) => `👋 *Olá ${nome}! Bem-vindo(a) ao Sora!* 💰

Sou sua assistente financeira no WhatsApp. Vou te ajudar a organizar tudo — gastos, receitas, contas e investimentos.

${HELP_TEXT}

🚀 Me manda seu primeiro lançamento!`;

// Normaliza telefone (remove tudo que não é dígito)
const norm = (p) => p ? p.replace(/\D/g, '') : p;

// Busca ou cria usuário + grupo
async function obterContexto(phone) {
  const { data: user } = await supabase
    .from('users')
    .select('*, grupos!users_grupo_ativo_fkey(*)')
    .eq('phone', phone)
    .single();
  return user;
}

// Verifica se o plano inclui investimentos
async function isBlack(phone) {
  const { data } = await supabase.from('users').select('plano').eq('phone', phone).single();
  return data?.plano === 'black';
}

// ─── WEBHOOK PRINCIPAL ────────────────────────────────────────────
router.post('/', async (req, res) => {
  let { phone, text, listResponseMessage, audio, image, fromMe } = req.body;
  phone = norm(phone);
  res.sendStatus(200); // responde imediatamente ao Z-API

  if (fromMe) return; // ignora mensagens enviadas pelo próprio bot

  let mensagem = text?.message || listResponseMessage?.title;

  // --- ÁUDIO ---
  if (audio?.audioUrl) {
    try {
      mensagem = await transcreverAudio(audio.audioUrl, phone);
      console.log(`🎤 Áudio transcrito [${phone}]: "${mensagem}"`);
    } catch {
      await enviarTexto(phone, '🎤 Não consegui entender o áudio. Pode repetir?');
      return;
    }
  }

  // --- IMAGEM (nota fiscal) ---
  if (image?.url) {
    const { data: user } = await supabase.from('users').select('plano').eq('phone', phone).single();
    if (!user || !['premium','black'].includes(user.plano)) {
      await enviarTexto(phone, '🚫 Leitura de notas fiscais é exclusiva dos planos Premium e Black.');
      return;
    }
    // OCR será tratado no handler de imagem (próxima etapa)
    mensagem = '__imagem__';
  }

  if (!mensagem || !phone) return;

  try {
    // ── 1. Busca usuário ──────────────────────────────────────────
    let { data: user } = await supabase
      .from('users').select('*').eq('phone', phone).single();

    // Novo usuário: pede o nome
    if (!user) {
      // Tenta extrair nome da primeira mensagem via IA
      const respNome = await interpretarMensagem(
        `O usuário enviou sua primeira mensagem: "${mensagem}". Extraia o nome próprio se houver, ou responda apenas a palavra PEDIR.`,
        {}
      );
      const nome = respNome?.acao === 'conversa' ? respNome.resposta : null;

      if (!nome || nome === 'PEDIR') {
        await enviarTexto(phone, '👋 Olá! Qual é o seu nome para começarmos?');
        return;
      }

      // Cria usuário — o trigger do Supabase cria o grupo automaticamente
      const { data: novoUser } = await supabase
        .from('users').insert({ phone, name: nome }).select().single();

      await enviarMenu(phone, WELCOME_TEXT(nome));
      return;
    }

    // ── 2. Garante que o usuário tem grupo ativo ──────────────────
    if (!user.grupo_ativo) {
      await enviarTexto(phone, '⚠️ Erro ao carregar seu perfil. Tente novamente.');
      return;
    }
    const grupoId = user.grupo_ativo;

    // ── 3. Interpreta a mensagem ──────────────────────────────────
    let data = interpretarRapido(mensagem); // tenta regex primeiro (grátis)

    // Se regex nao identificou, tenta classificar Finance vs Grow (usuarios com acesso ao Grow)
    if (!data && temAcessoGrow(user)) {
      const intencao = await classificarIntencao(mensagem);
      console.log(`🧭 [${phone}] intencao classificada: ${intencao}`);
      if (intencao === 'grow') {
        const ctx = { phone, grupoId: user.grupo_ativo, user, mensagem };
        await require('../handlers/grow')(mensagem, ctx);
        return;
      }
    }

    if (!data) {
      console.log(`🤖 Chamando IA para: "${mensagem}"`);
      // Passa wallet_padrao_nome no contexto pra IA usar como default
      let walletPadraoNome = null;
      if (user?.wallet_padrao_id) {
        try {
          const { data: wp } = await supabase
            .from('wallets').select('nome').eq('id', user.wallet_padrao_id).single();
          walletPadraoNome = wp?.nome || null;
        } catch {}
      }
      const ctxIA = walletPadraoNome
        ? { resumo: `wallet_padrao_nome: ${walletPadraoNome}` }
        : {};
      data = await interpretarMensagem(mensagem, ctxIA);
    }

    // Se a IA retornou uma acao do Grow, roteia direto
    if (data?.acao && /^(grow_|habito_|tarefa_|humor_|compra_)/i.test(data.acao) && temAcessoGrow(user)) {
      const ctx = { phone, grupoId: user.grupo_ativo, user, mensagem };
      await require('../handlers/grow')(mensagem, ctx);
      return;
    }

    console.log(`📩 [${phone}] "${mensagem}" → ação: ${data?.acao}`);

    // ── 4. Roteia para o handler correto ──────────────────────────
    const ctx = { phone, grupoId, user, mensagem };

    switch (data.acao) {

      case 'conversa':
        await enviarTexto(phone, data.resposta);
        break;

      case 'ajuda':
        await enviarMenu(phone, HELP_TEXT);
        break;

      case 'painel':
        await enviarTexto(phone, `🌐 Acesse seu painel:\n\n${process.env.PAINEL_URL}?phone=${phone}`);
        break;

      // Transações
      case 'salvar':
      case 'apagar':
      case 'buscar':
      case 'resumo':
      case 'analisar':
        require('../handlers/transacoes')(data, ctx);
        break;

      // Contas bancárias
      case 'set_wallet':
      case 'adicionar_saldo':
      case 'alterar_saldo':
      case 'ver_saldos':
      case 'transferir':
      case 'deletar_conta':
        require('../handlers/wallets')(data, ctx);
        break;

      // Parcelas e fatura
      case 'compra_parcelada':
      case 'pagar_parcela':
      case 'confirmar_pagamento_parcela':
      case 'set_fatura_dia':
        require('../handlers/parcelas')(data, ctx);
        break;

      // Limites e metas de gastos
      case 'set_limite':
      case 'set_meta':
      case 'meus_limites':
        require('../handlers/limites')(data, ctx);
        break;

      // Recorrências e lembretes
      case 'set_recorrente':
      case 'cancelar_recorrencia':
      case 'criar_lembrete':
        require('../handlers/recorrencias')(data, ctx);
        break;

      // Grupos
      case 'criar_grupo':
      case 'convidar_grupo':
      case 'entrar_grupo':
      case 'meus_grupos':
      case 'trocar_grupo':
      case 'listar_membros':
      case 'remover_membro':
        require('../handlers/grupos')(data, ctx);
        break;

      // Dívidas
      case 'criar_divida':
      case 'listar_dividas':
      case 'pagar_divida':
      case 'quitar_divida':
      case 'cancelar_lembrete_divida':
      case 'ativar_lembrete_divida':
        require('../handlers/dividas')(data, ctx);
        break;

      // Investimentos (Black)
      case 'criar_investimento':
      case 'listar_investimentos':
      case 'registrar_aporte':
      case 'listar_aportes':
      case 'criar_meta':
      case 'listar_metas':
      case 'progresso_meta':
      case 'sugerir_alocacao':
      case 'gerar_dicas':
      case 'ver_dividendos':
        require('../handlers/investimentos')(data, ctx);
        break;

      default:
        await enviarTexto(phone, 'Não entendi. Digite *ajuda* para ver os comandos disponíveis.');
    }

  } catch (err) {
    console.error('❌ Erro no webhook:', err.message);
    await enviarTexto(phone, '⚠️ Ocorreu um erro interno. Tente novamente.');
  }
});

module.exports = router;