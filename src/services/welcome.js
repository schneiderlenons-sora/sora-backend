// =====================================================================
// Mensagem de boas-vindas enviada pelo WhatsApp da Sora.
// Disparada após o usuário vincular o número (via POST /api/user/welcome).
// Usa welcomed_at na tabela users pra evitar reenvio.
// =====================================================================

const supabase = require('../db/supabase');
const { enviarTexto } = require('./zapi');

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://forsora.com';

/**
 * Monta a mensagem de boas-vindas personalizada.
 * Tom amigável, deixa o link de onboarding bem visível.
 */
function montarMensagem({ nome, primeiroAcesso }) {
  const primeiroNome = (nome || 'tudo bem').split(' ')[0];

  if (primeiroAcesso) {
    return [
      `Oi ${primeiroNome}! 👋 Sou a Sora — sua assistente financeira.`,
      ``,
      `Sua conta tá ativa 🎉`,
      ``,
      `Pra começar, vou te guiar nos primeiros passos pra organizar tudo em 3 minutinhos:`,
      `👉 ${APP_URL}/onboarding`,
      ``,
      `Quando terminar, é só me mandar mensagem aqui mesmo pra registrar gastos por *texto*, *áudio*, *foto* ou até *PDF* 😉`,
      ``,
      `Digite *ajuda* a qualquer momento pra ver tudo que eu sei fazer.`,
    ].join('\n');
  }

  // Reenvio (ex.: usuário trocou o WhatsApp)
  return [
    `Oi ${primeiroNome}! 👋`,
    ``,
    `Esse número agora está vinculado à sua conta na Sora ✓`,
    ``,
    `Continue de onde parou:`,
    `👉 ${APP_URL}/dashboard`,
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
    try {
      const patch = { phone };   // já chega normalizado do route
      if (nome) patch.name = nome;
      await supabase.from('users').update(patch).eq('id', user_id);
    } catch (e) {
      console.warn('[welcome] erro ao salvar phone:', e.message);
    }
  }

  // Verifica se já enviou
  let primeiroAcesso = true;
  if (user_id && !force) {
    try {
      const { data: user } = await supabase
        .from('users')
        .select('welcomed_at, name')
        .eq('id', user_id)
        .maybeSingle();

      if (user?.welcomed_at) {
        primeiroAcesso = false;
      }
      if (!nome && user?.name) nome = user.name;
    } catch (e) {
      console.warn('[welcome] erro ao consultar welcomed_at:', e.message);
    }
  }

  const mensagem = montarMensagem({ nome, primeiroAcesso });

  try {
    await enviarTexto(phone, mensagem);
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
