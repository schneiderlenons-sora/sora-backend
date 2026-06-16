const express  = require('express');
const router   = express.Router();
const supabase = require('../db/supabase');
const { enviarTexto, enviarMenu, enviarLink, enviarBotaoLink, enviarImagem } = require('../services/zapi');
const APP_URL_WH = process.env.NEXT_PUBLIC_APP_URL || 'https://forsora.com';
const SORA_CAPA = process.env.SORA_CAPA_URL || `${APP_URL_WH}/sora-capa.png`;
const { interpretarMensagem, classificarIntencao } = require('../services/ia');
const { transcreverAudio }        = require('../services/whisper');
const { lerNotaFiscal }           = require('../services/ocr');
const { interpretarRapido }       = require('../handlers/interpretador');
const { buscarPendente }          = require('../services/pendentes');
const { resolverPendente }        = require('../handlers/pendentes');

// Verifica acesso ao Grow BASE (hábitos, tarefas, bem-estar, lista de compras,
// agenda). Modelo novo: TODOS os planos têm o Grow base. Saúde/Estudos/Casa-
// avançada são Premium+ e ficam gated dentro do handler (temGrowPremium).
function temAcessoGrow(user) {
  if (!user) return false;
  if (['basico', 'premium', 'black'].includes(user.plano)) return true;
  if (['grow_basico', 'grow_premium'].includes(user.plano_grow)) return true;
  if (user.plano_grow === 'trial' && user.grow_trial_fim && new Date(user.grow_trial_fim) > new Date()) return true;
  return false;
}

// Textos fixos
const HELP_TEXT = `💬 *Sora — comandos principais*

_Fala em texto ou áudio, em linguagem natural_ 😉

💸 *Lançar*
• "gastei 50 no mercado"
• "recebi 3500 de salário"
• "apagar último"

🏦 *Contas & cartões*
• "saldo"  ·  "fatura nubank"
• "pagar fatura nubank"
• "transferir 200 do nubank pro inter"

📊 *Resumo & metas*
• "resumo"  ·  "analisar"
• "limite 2000"  ·  "minhas dívidas"

📅 *Agenda*
• "marca dentista terça 15h"
• "tenho reunião amanhã às 19, me lembra?"

🌱 *Sora Grow*
• "grow hábitos"  ·  "grow tarefas"
• "comi 2 ovos e café" → registra a refeição
• "grow" → menu completo do Grow

🌐 "painel" → abrir o app

━━━━━━━━━━━━━━━━
✨ *Quer ver TODOS os comandos?*
Acesse a *Central da Sora* no app 👉
www.forsora.com/central-sora`;

const WELCOME_TEXT = (nome) => `👋 *Olá, ${nome}! Bem-vindo(a) à Sora!* 🌿

Sou sua assistente financeira no WhatsApp. Fala comigo em texto ou áudio — sem comandos difíceis.

✅ "gastei 50 no mercado"
✅ "recebi 3500 de salário"
✅ "fatura nubank" / "resumo" / "saldo"

Digite *ajuda* a qualquer momento pra ver o menu completo.

🚀 Me manda seu primeiro lançamento!`;

// ── PRÉ-VENDA: lead (sem plano pago) perguntando sobre testar/comprar/preço ──
// Local-first (sem IA): responde como vendedora — demo ao vivo no site + planos
// + cadastro. Antes disso, a Sora caía na "conversa" genérica da IA (papo de
// e-commerce sem contexto), perdendo o lead no momento mais quente do funil.
function pareceVenda(msg) {
  const t = (msg || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return /\b(testar|teste|experimentar|demonstrac|demo|antes de comprar|quero comprar|vou comprar|como (comprar|assinar|funciona|contrat)|assinar|assinatura|contratar|adquirir|preco|precos|quanto custa|qual o valor|mensalidade|mensalidades|plano|planos|e gratis|gratis|gratuit|trial|periodo de teste|vale a pena|o que (voce|vc) faz|o que e a sora|pra que serve|como (voce|vc) funciona)\b/.test(t);
}

const VENDAS_TEXT = (nome) => `${nome ? `Oi, ${nome}! ` : 'Oi! '}Que bom que você quer conhecer a Sora antes de assinar 💚

Eu sou sua *assistente financeira no WhatsApp*: você me fala em texto ou áudio — tipo *"gastei 50 no mercado"* ou *"recebi 3000 de salário"* — e eu organizo tudo sozinha: gastos, contas, cartões, metas e relatórios. 📊

🎬 *Quer me ver funcionando agora, de graça?*
Tem uma demonstração ao vivo no site (o *Test Drive*) — você digita e vê na hora como eu respondo, sem compromisso:
👉 forsora.com

💚 *Planos a partir de R$ 19,90/mês* — sem fidelidade, cancela quando quiser:
👉 forsora.com/planos

Pode me perguntar o que quiser sobre os planos ou sobre o que eu faço! 😉`;

// Mostrado quando um lead (sem plano) tenta USAR uma função (lançar, saldo…).
const PAYWALL_TEXT = `🔒 Pra organizar suas finanças comigo de verdade — lançar gastos, ver saldo, metas, relatórios — você precisa de um plano ativo.

🎬 Mas pode me ver funcionando agora, de graça, na demo ao vivo: 👉 forsora.com
💚 Planos a partir de *R$ 19,90/mês*, sem fidelidade: 👉 forsora.com/planos

Qualquer dúvida sobre os planos, é só perguntar! 😉`;

// Suporte humano — usado quando o usuário pede ajuda, relata bug ou a Sora
// não entende a mensagem.
const SUPORTE_TEXT = `Quer falar com a gente? Tô aqui pra ajudar 💚

Pra dúvidas, problemas ou pra relatar um bug, é só chamar o nosso suporte:

📧 *E-mail:* contatosora.ai@gmail.com
📱 *WhatsApp:* (32) 99916-7475

Manda o que aconteceu com o máximo de detalhes que o time te responde rapidinho! 🙌`;

// Cancelamento — orienta a cancelar pela Stripe (portal seguro), de forma
// gentil e fácil de seguir.
const CANCELAR_TEXT = `Poxa, que pena que você quer cancelar 😢 Mas fica tranquilo: você mesmo faz em menos de 1 minutinho, na hora que quiser.

A sua assinatura é cuidada pela *Stripe* (nosso sistema de pagamento seguro). Pra cancelar:

1️⃣ Acesse *forsora.com* e entre na sua conta
2️⃣ Vá em *Configurações → Plano e Cobrança*
3️⃣ Toque em *Gerenciar assinatura* (abre o portal da Stripe)
4️⃣ Escolha *Cancelar plano* e confirme

Pronto! ✅ Você continua com acesso até o fim do período que já pagou e não recebe mais nenhuma cobrança.

Se tiver qualquer dificuldade, é só chamar o suporte: 📧 contatosora.ai@gmail.com`;

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
      // Lead novo já chegando com intenção de testar/comprar/preço → pitch
      // direto (sem pedir nome). Ele se cadastra no site.
      if (pareceVenda(mensagem)) {
        await enviarTexto(phone, VENDAS_TEXT(null));
        console.log(`💚 [${phone}] pré-venda (número novo): "${mensagem}"`);
        return;
      }
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

    // ── 2.4. PRÉ-VENDA: lead sem plano pago perguntando sobre testar/comprar/
    // preço/planos → responde como vendedora (local-first), em vez de cair na
    // "conversa" genérica da IA. Não intercepta quem já é assinante.
    if (!temAcessoGrow(user) && pareceVenda(mensagem)) {
      await enviarTexto(phone, VENDAS_TEXT(user.name));
      console.log(`💚 [${phone}] pré-venda (lead sem plano): "${mensagem}"`);
      return;
    }

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

    // Fast-path da AGENDA (determinístico, sem IA): criar ("marca X terça 15h",
    // "tenho reunião amanhã às 19, me lembra?") OU ajustar o lembrete do último
    // ("me lembra 1 dia antes"). Sem isso, a IA às vezes manda pra Finance/conversa.
    if (!data && temAcessoGrow(user) && require('../handlers/grow').pareceAgenda(mensagem)) {
      const ctx = { phone, grupoId: user.grupo_ativo, user, mensagem };
      await require('../handlers/grow')(mensagem, ctx);
      return;
    }

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
      // Lead sem plano: avisa a IA pra responder a dúvida no tom de venda.
      if (!temAcessoGrow(user)) {
        ctxIA.resumo = (ctxIA.resumo ? ctxIA.resumo + '\n' : '')
          + 'OBS: usuário ainda SEM plano ativo (lead). Responda a dúvida de forma útil e, se fizer sentido, convide a conhecer a demo e os planos em forsora.com.';
      }
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

    // ── 3.5. PAYWALL: lead sem plano pode TIRAR DÚVIDAS (conversa), mas não
    // USAR funções (lançar, saldo, etc.). Qualquer ação financeira é bloqueada
    // com convite de assinatura. 'ajuda'/'painel' também viram convite. ──────
    // 'suporte' e 'cancelar_plano' valem pra todo mundo (inclusive lead/inativo):
    // pedir ajuda ou querer cancelar não pode esbarrar no paywall.
    const ACOES_LIVRES = ['conversa', 'suporte', 'cancelar_plano', 'config_resumos'];
    if (!temAcessoGrow(user) && data?.acao && !ACOES_LIVRES.includes(data.acao)) {
      await enviarLink(phone, {
        message: PAYWALL_TEXT,
        image: SORA_CAPA,
        linkUrl: `${APP_URL_WH}/planos`,
        title: '💚 Planos da Sora',
        linkDescription: 'Ver os planos',
      });
      console.log(`🔒 [${phone}] lead bloqueado na ação "${data.acao}"`);
      return;
    }

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
        // send-image: capa como banner no topo + texto (com link) na legenda.
        await enviarImagem(phone, SORA_CAPA,
          '🐳 *Seu painel da Sora*\n\nGráficos, saldos, metas e tudo organizado num lugar só.\n\n' +
          `👉 ${APP_URL_WH}/dashboard`);
        break;

      case 'suporte':
        await enviarTexto(phone, SUPORTE_TEXT);
        break;

      case 'config_resumos':
        if (user?.id) {
          await supabase.from('users')
            .update({ resumo_semanal: data.valor, resumo_mensal: data.valor })
            .eq('id', user.id);
        }
        await enviarTexto(phone, data.valor
          ? '✅ Resumos *ativados*! Toda segunda eu te mando o resumo da semana e, no início do mês, o fechamento do mês anterior.'
          : '🔕 Resumos *desativados*. Não vou mais te mandar os resumos semanais/mensais. Quando quiser de volta, é só dizer *ativar resumos*.');
        break;

      case 'cancelar_plano':
        await enviarTexto(phone, CANCELAR_TEXT);
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