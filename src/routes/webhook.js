const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const { enviarTexto, enviarMenu } = require('../services/zapi');
const { interpretarMensagem, classificarIntencao } = require('../services/ia');
const { transcreverAudio }        = require('../services/whisper');
const { lerNotaFiscal }           = require('../services/ocr');
const { interpretarRapido }       = require('../handlers/interpretador');
const { buscarPendente }          = require('../services/pendentes');
const { resolverPendente }        = require('../handlers/pendentes');

// Verifica acesso ao Grow
function temAcessoGrow(user) {
  if (!user) return false;
  if (user.plano === 'black') return true;
  if (['grow_basico','grow_premium'].includes(user.plano_grow)) return true;
  if (user.plano_grow === 'trial' && user.grow_trial_fim && new Date(user.grow_trial_fim) > new Date()) return true;
  return false;
}

// Textos fixos
const HELP_TEXT = `╔══════════════════════╗
║  💬 *Sora — Ajuda*       ║
╚══════════════════════╝

_Fala comigo em texto ou áudio — entendo linguagem natural_ 😉

━━━━━━━━━━━━━━━━
💸 *LANÇAMENTOS*
• "gastei 50 no mercado"
• "gastei 200 no nubank crédito"
• "recebi 3500 de salário"
• "gastei 80 em farmácia categoria saúde"
↩️ "apagar último" — remove o último lançamento

━━━━━━━━━━━━━━━━
🏦 *CONTAS & CARTÕES*
• "nubank 1000" → cria conta corrente
• "cartão nubank limite 5000 fecha 5 vence 15"
• "saldo" → ver todos os saldos
• "ajustar nubank 850" → corrigir saldo
• "transferir 200 do nubank pro inter"

━━━━━━━━━━━━━━━━
💳 *PARCELADO & FATURA*
• "comprei fone em 3x de 150 no nubank crédito"
• "antecipar parcela do fone"
• "fatura nubank" → ver fatura do mês

━━━━━━━━━━━━━━━━
🔁 *CONTAS FIXAS & LEMBRETES*
• "todo mês 1000 aluguel dia 5"
• "lembrete pagar internet dia 10"
• "cancelar recorrência aluguel"

━━━━━━━━━━━━━━━━
📊 *RELATÓRIOS & LIMITES*
• "resumo" → relatório do mês
• "analisar" → análise inteligente dos gastos
• "limite 2000" → meta total de gastos
• "limite mercado 500" → limite por categoria

━━━━━━━━━━━━━━━━
💰 *DÍVIDAS*
• "criar divida empréstimo nubank 5000 em 10x dia 15"
• "minhas dívidas"
• "pagar divida nubank 250"
• "quitar divida nubank"

━━━━━━━━━━━━━━━━
👥 *GRUPOS (compartilhado)*
• "criar grupo família"
• "convidar grupo 11999998888"
• "meus grupos" / "trocar grupo"

━━━━━━━━━━━━━━━━
🌱 *SORA GROW*
Rotinas, hábitos, saúde, estudos e mais.
• "grow hábitos" → ver seus hábitos
• "grow tarefas" → lista de tarefas
• "grow humor 4" → registrar humor do dia
• "grow" → menu do Sora Grow

━━━━━━━━━━━━━━━━
🌐 "painel" → abrir painel web
❓ "ajuda" → este menu
━━━━━━━━━━━━━━━━`;

const WELCOME_TEXT = (nome) => `👋 *Olá, ${nome}! Bem-vindo(a) à Sora!* 🌿

Sou sua assistente financeira no WhatsApp. Fala comigo em texto ou áudio — sem comandos difíceis.

✅ "gastei 50 no mercado"
✅ "recebi 3500 de salário"
✅ "fatura nubank" / "resumo" / "saldo"

Digite *ajuda* a qualquer momento pra ver o menu completo.

🚀 Me manda seu primeiro lançamento!`;

// Normaliza telefone (remove tudo que não é dígito)
const norm = (p) => p ? p.replace(/\D/g, '') : p;

// Retorna variantes do número para busca:
// Z-API envia sem o 9º dígito (12 dígitos) mas usuários podem cadastrar
// com ele (13 dígitos). Tenta os dois formatos.
function variantesPhone(phone) {
  const variantes = [phone];
  // 55 + DDD(2) + 9 + número(8) = 13 → remove o 9 → 12
  if (phone.length === 13 && phone.startsWith('55')) {
    variantes.push(phone.slice(0, 4) + phone.slice(5)); // remove posição 4 (o '9')
  }
  // 55 + DDD(2) + número(8) = 12 → adiciona 9 → 13
  if (phone.length === 12 && phone.startsWith('55')) {
    variantes.push(phone.slice(0, 4) + '9' + phone.slice(4));
  }
  return variantes;
}

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

  // Ignora mensagens de teste injetadas pela Z-API em contas trial
  if (mensagem && (
    mensagem.includes('MENSAGEM DE TESTE') ||
    mensagem.includes('CONTA EM TRIAL') ||
    mensagem.includes('FAVOR DESCONSIDERAR') ||
    mensagem.includes('Corpo da mensagem enviada')
  )) return;

  // --- ÁUDIO ---
  if (audio?.audioUrl) {
    try {
      // Dica de vocabulário: nomes das contas do usuário → transcrição mais
      // precisa ("Nubank Crédito" em vez de "no banco de crédito").
      let vocab = '';
      try {
        const { data: u } = await supabase.from('users').select('grupo_ativo').eq('phone', phone).maybeSingle();
        if (u?.grupo_ativo) {
          const { data: ws } = await supabase.from('wallets').select('nome').eq('grupo_id', u.grupo_ativo);
          vocab = (ws || []).map(w => w.nome).filter(Boolean).join(', ');
        }
      } catch {}
      mensagem = await transcreverAudio(audio.audioUrl, phone, vocab);
      console.log(`🎤 Áudio transcrito [${phone}]: "${mensagem}"`);
    } catch {
      await enviarTexto(phone, '🎤 Não consegui entender o áudio. Pode repetir?');
      return;
    }
  }

  // --- IMAGEM (nota fiscal / comprovante) ---
  // Só guarda a URL aqui; o OCR roda depois de carregar o usuário (pra
  // checar plano e ter o contexto do grupo).
  const imageUrl = image?.url || image?.imageUrl || null;
  if (imageUrl) mensagem = '__imagem__'; // placeholder pra passar a validação abaixo

  if (!mensagem || !phone) return;

  try {
    // ── 1. Busca usuário (tenta com e sem o 9º dígito brasileiro) ──
    let user = null;
    for (const variante of variantesPhone(phone)) {
      const { data } = await supabase
        .from('users').select('*').eq('phone', variante).maybeSingle();
      if (data) { user = data; break; }
    }

    // Novo usuário: pede o nome
    if (!user) {
      // Tenta extrair nome da primeira mensagem via IA
      const respNome = await interpretarMensagem(
        `O usuário enviou sua primeira mensagem: "${mensagem}". Extraia o nome próprio se houver, ou responda apenas a palavra PEDIR.`,
        {}
      );
      const nome = respNome?.acao === 'conversa' ? respNome.resposta : null;

      // Comparação case-insensitive — GPT pode retornar "Pedir", "pedir" ou "PEDIR"
      if (!nome || nome.trim().toUpperCase() === 'PEDIR') {
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

    // ── 2.5. Verifica se há pendente aguardando resposta ──────────
    // Se a última interação foi uma pergunta da Sora (ex.: "de qual conta?"),
    // tenta resolver com a mensagem atual antes de interpretar como nova ação.
    const pendente = await buscarPendente(user.id);
    if (pendente) {
      const resolvido = await resolverPendente(pendente, mensagem, {
        phone, grupoId, user,
      });
      if (resolvido) return; // consumiu a mensagem
    }

    // ── 2.7. IMAGEM (nota fiscal / comprovante) ───────────────────
    let data = null;
    if (imageUrl) {
      if (!['premium', 'black'].includes(user.plano)) {
        await enviarTexto(phone, '🚫 Leitura de notas fiscais e comprovantes é exclusiva dos planos Premium e Black.');
        return;
      }
      await enviarTexto(phone, '🔍 Analisando a imagem...');
      const ocr = await lerNotaFiscal(imageUrl);
      if (!ocr || ocr.acao === 'erro_ocr' || !ocr.valor) {
        await enviarTexto(phone, '📷 Não consegui ler os dados dessa imagem. Tente uma foto mais nítida da nota/comprovante, ou registre por texto (ex: "gastei 50 no mercado").');
        return;
      }
      data = ocr; // { acao: 'salvar', tipo, valor, categoria, observacao }
      // Usa o nome do estabelecimento como contexto pra refinar categoria
      // (ex: nota da "Shein" → subcategoria Shein no handler de transações)
      if (ocr.observacao) mensagem = ocr.observacao;
    }

    // ── 3. Interpreta a mensagem ──────────────────────────────────
    if (!data) data = interpretarRapido(mensagem); // tenta regex primeiro (grátis)

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
    // 'compra_parcelada' é do cartão (Finance), não confundir com compra_ do Grow
    if (data?.acao && /^(grow_|habito_|tarefa_|humor_|compra_(?!parcelada))/i.test(data.acao) && temAcessoGrow(user)) {
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
        await enviarTexto(phone, `🌐 *Acesse seu painel:*\n\nhttps://www.forsora.com/dashboard`);
        break;

      // Transações
      case 'salvar':
      case 'apagar':
      case 'buscar':
      case 'resumo':
      case 'analisar':
        require('../handlers/transacoes')(data, ctx);
        break;

      // Contas bancárias + cartões de crédito
      case 'set_wallet':
      case 'set_cartao':
      case 'adicionar_saldo':
      case 'alterar_saldo':
      case 'ver_saldos':
      case 'transferir':
      case 'deletar_conta':
        require('../handlers/wallets')(data, ctx);
        break;

      // Parcelas e fatura
      case 'compra_parcelada':
      case 'antecipar_parcela':
      case 'set_fatura_dia':
      case 'pagar_fatura':
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

      // Metas financeiras (poupança)
      case 'aporte_meta':
        require('../handlers/metas')(data, ctx);
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