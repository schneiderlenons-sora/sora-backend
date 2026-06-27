// =====================================================================
// Recuperação de pagamento de assinatura recusado.
//
// Fluxo: o webhook do Stripe (frontend) marca `recuperacao_pendente_em` no
// usuário quando o pagamento falha. Este serviço (rodado por um cron do
// backend) manda o WhatsApp de recuperação — link de LOGIN (a conta já existe)
// + cupom SORA15 — e marca `recuperacao_enviada_em` pra não reenviar.
//
// Importante: aponta pro /login (e NÃO pro /planos), porque a conta do lead já
// foi criada antes do pagamento que falhou. E o checkout da Sora aceita cupom
// (allow_promotion_codes), então SORA15 funciona direto no checkout.
// =====================================================================
const supabase = require('../db/supabase');
const { enviarTexto } = require('./mensageiro');

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://forsora.com';

// Espera ~30 min antes de mandar — dá tempo do lead tentar de novo na hora
// (com outro cartão) sem receber a mensagem à toa.
const DELAY_MIN = 30;
// Janela em que o lead é tratado como "em recuperação" (CTA pro login + cupom).
const JANELA_DIAS = 7;

// Mensagem persuasiva de recuperação (proativa e também usada quando o lead
// responde no WhatsApp). Tom acolhedor: "aconteceu, é rápido finalizar".
function RECUPERACAO_TEXT(nome) {
  const primeiro = (nome || '').split(' ')[0];
  return [
    `Oi${primeiro ? ` ${primeiro}` : ''}! 👋 Aqui é a Sora.`,
    ``,
    `Reparei que você começou a assinar mas o pagamento não passou — pelo visto foi só o cartão sem saldo na hora 🙈 Acontece com todo mundo!`,
    ``,
    `E olha a boa notícia: *sua conta já está criada* e tá tudo guardado. Falta só 1 passinho pra você destravar tudo — registrar gastos por texto/áudio/foto e ter contas, metas e relatórios no automático 📊`,
    ``,
    `✅ É só finalizar por aqui:`,
    `👉 ${APP_URL}/login`,
    `_(esqueceu a senha? tem o "esqueci a senha" na mesma tela)_`,
    ``,
    `🎁 *E aqui vai um presentinho:* adicione o cupom *SORA15* no checkout pra ganhar *15% de desconto* — válido só por *24 horas* ⏳🙌`,
    ``,
    `Bora deixar sua vida financeira no controle? Qualquer dúvida, é só me chamar aqui 💚`,
  ].join('\n');
}

// True quando o usuário é um lead em recuperação (plano inativo + marcado
// recente). Usado no webhook pra trocar o CTA de cadastro por login + cupom.
function emRecuperacao(user) {
  if (!user || user.plano !== 'inativo') return false;
  const marca = user.recuperacao_enviada_em || user.recuperacao_pendente_em;
  if (!marca) return false;
  const dias = (Date.now() - new Date(marca).getTime()) / 86400000;
  return dias >= 0 && dias <= JANELA_DIAS;
}

// Worker do cron: manda a recuperação pra quem falhou, ainda está inativo e
// nunca recebeu. Tolerante: se a migration 047 não rodou, só loga e sai.
async function processarRecuperacoes() {
  const limite = new Date(Date.now() - DELAY_MIN * 60000).toISOString();
  const { data: users, error } = await supabase.from('users')
    .select('id, name, phone, recuperacao_pendente_em')
    .eq('plano', 'inativo')
    .is('recuperacao_enviada_em', null)
    .not('recuperacao_pendente_em', 'is', null)
    .lt('recuperacao_pendente_em', limite)
    .not('phone', 'is', null);

  if (error) {
    console.warn('[recuperacao] query falhou (migration 047 rodou?):', error.message);
    return;
  }

  for (const u of users || []) {
    try {
      await enviarTexto(u.phone, RECUPERACAO_TEXT(u.name));
      await supabase.from('users').update({
        recuperacao_enviada_em:  new Date().toISOString(),
        recuperacao_pendente_em: null,
      }).eq('id', u.id);
      console.log(`💸 [recuperacao] enviada p/ ${u.phone}`);
    } catch (e) {
      console.error('[recuperacao] erro ao enviar p/', u.phone, e.message);
    }
  }
}

module.exports = { RECUPERACAO_TEXT, emRecuperacao, processarRecuperacoes };
