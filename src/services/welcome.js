// =====================================================================
// Mensagem de boas-vindas enviada pelo WhatsApp da Sora.
// Disparada após o usuário vincular o número (via POST /api/user/welcome).
// Usa welcomed_at na tabela users pra evitar reenvio.
// =====================================================================

const supabase = require('../db/supabase');
const { enviarTexto, enviarLink } = require('./zapi');

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://forsora.com';
// Capa da marca (mesma usada nos resumos). Acompanha a boas-vindas como imagem
// + legenda. Se o envio da imagem falhar, enviarImagem cai pra texto.
const CAPA = process.env.SORA_CAPA_URL || `${APP_URL}/sora-capa.png`;

/**
 * Monta a mensagem de boas-vindas personalizada.
 * Tom amigável, deixa o link de onboarding bem visível.
 */
function montarMensagem({ nome, primeiroAcesso, onboardingCompleto }) {
  const primeiroNome = (nome || 'tudo bem').split(' ')[0];

  if (primeiroAcesso) {
    const linhas = [
      `Oi ${primeiroNome}! 👋 Sou a Sora — sua assistente financeira.`,
      ``,
      `Seu plano tá ativo 🎉`,
      ``,
    ];
    if (onboardingCompleto) {
      // Já passou pelo onboarding → manda direto o link do painel.
      linhas.push(
        `Tudo pronto! Acesse seu painel quando quiser:`,
        `👉 ${APP_URL}/dashboard`,
        ``,
        `E aqui no WhatsApp é só me mandar mensagem pra registrar gastos por *texto*, *áudio*, *foto* ou até *PDF* 😉`,
      );
    } else {
      // Ainda não fez o onboarding → guia pelos primeiros passos, mas já manda
      // também o link do painel (acesso direto quando quiser).
      linhas.push(
        `Pra começar, vou te guiar nos primeiros passos pra organizar tudo em 3 minutinhos:`,
        `👉 ${APP_URL}/onboarding`,
        ``,
        `Seu painel completo fica sempre aqui:`,
        `👉 ${APP_URL}/dashboard`,
        ``,
        `Quando terminar, é só me mandar mensagem aqui mesmo pra registrar gastos por *texto*, *áudio*, *foto* ou até *PDF* 😉`,
      );
    }
    linhas.push(``, `Digite *ajuda* a qualquer momento pra ver tudo que eu sei fazer.`);
    return linhas.join('\n');
  }

  // Reenvio (ex.: usuário trocou o WhatsApp)
  return [
    `Oi ${primeiroNome}! 👋`,
    ``,
    `Esse número agora está vinculado à sua conta na Sora ✓`,
    ``,
    `Continue de onde parou:`,
    `👉 ${APP_URL}/${onboardingCompleto ? 'dashboard' : 'onboarding'}`,
  ].join('\n');
}

/**
 * Dispara a mensagem de boas-vindas pro WhatsApp do usuário.
 * Idempotente: só envia uma vez por user_id (welcomed_at).
 *
 * @param {Object} params
 * @param {string} params.user_id    — UUID do usuário no Supabase
 * @param {string} params.phone      — número normalizado (apenas dígitos)
 * @param {string} [params.nome]     — primeiro nome pra personalizar
 * @param {boolean}[params.force]    — força reenvio mesmo se welcomed_at != null
 * @returns {Promise<{ enviado: boolean, motivo?: string }>}
 */
async function enviarBoasVindas({ user_id, phone, nome, force = false }) {
  if (!phone) {
    return { enviado: false, motivo: 'phone não informado' };
  }

  // Persiste o número (e nome) no perfil — fonte confiável (service role),
  // independente do timing da sessão no cliente. É aqui que o WhatsApp fica
  // de fato vinculado ao cadastro.
  if (user_id) {
    const patch = { phone };   // já chega normalizado do route
    if (nome) patch.name = nome;
    const { error: upErr } = await supabase
      .from('users').update(patch).eq('id', user_id).select('id');
    if (upErr) {
      // 23505 = unique_violation no users_phone_key: o número JÁ está vinculado
      // a OUTRA conta. Em vez de falhar em silêncio (deixando phone null e o
      // onboarding inteiro quebrado, pois o app é keyed by phone), sinaliza pro
      // frontend bloquear o cadastro com uma mensagem clara.
      if (upErr.code === '23505') {
        return { enviado: false, motivo: 'phone_em_uso' };
      }
      console.warn('[welcome] erro ao salvar phone:', upErr.message);
    }
  }

  // Lê o estado do usuário: plano (gate), onboarding (link) e welcomed_at (idempotência).
  let primeiroAcesso = true;
  let onboardingCompleto = false;
  let plano = null;
  if (user_id) {
    try {
      const { data: user } = await supabase
        .from('users')
        .select('welcomed_at, name, plano, onboarding_completed')
        .eq('id', user_id)
        .maybeSingle();

      if (user) {
        if (user.welcomed_at && !force) primeiroAcesso = false;
        if (!nome && user.name) nome = user.name;
        onboardingCompleto = !!user.onboarding_completed;
        plano = user.plano;
      }
    } catch (e) {
      console.warn('[welcome] erro ao consultar usuário:', e.message);
    }
  }

  // GATE: a Sora só manda boas-vindas com o PLANO ATIVO. Antes do pagamento o
  // número já fica vinculado (acima), mas nenhuma mensagem é enviada — evita a
  // Sora falar com quem ainda não pagou. Quando o plano ativa (webhook/sync), o
  // frontend chama o welcome de novo e aí a mensagem sai.
  const planoAtivo = plano && plano !== 'inativo';
  if (!planoAtivo) {
    return { enviado: false, motivo: 'plano_inativo' };
  }

  const mensagem = montarMensagem({ nome, primeiroAcesso, onboardingCompleto });

  try {
    // Boas-vindas como CARD de link (igual aos resumos): capa em paisagem no
    // topo + título + corpo + botão. NÃO usar send-image (vira foto quadrada
    // clicável). enviarLink cai pra texto se o send-link falhar.
    const destino = onboardingCompleto ? `${APP_URL}/dashboard` : `${APP_URL}/onboarding`;
    await enviarLink(phone, {
      message: mensagem,
      image: CAPA,
      linkUrl: destino,
      title: '🐳 Bem-vindo à Sora',
      linkDescription: onboardingCompleto ? 'Abrir painel' : 'Começar agora',
    });
  } catch (e) {
    console.error('[welcome] erro ao enviar Z-API:', e.message);
    return { enviado: false, motivo: e.message };
  }

  // Marca como enviada
  if (user_id) {
    try {
      await supabase
        .from('users')
        .update({ welcomed_at: new Date().toISOString() })
        .eq('id', user_id);
    } catch (e) {
      console.warn('[welcome] erro ao marcar welcomed_at:', e.message);
    }
  }

  return { enviado: true };
}

module.exports = { enviarBoasVindas, montarMensagem };
