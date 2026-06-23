// =====================================================================
// Recuperação de CADASTROS SEM PAGAMENTO (abandono no paywall).
// Segmento: plano 'inativo' que NUNCA teve assinatura ativa
// (plano_intervalo IS NULL — distingue de quem cancelou), com WhatsApp,
// criado há mais de 2h (deixa finalizar naturalmente) e até 90 dias atrás.
// Manda 1 WhatsApp com link de login + cupom SORA15. Dedup: recuperacao_signup_em.
// O link leva ao login do app — o checkout só ativa o plano logado (carrega o
// supabase_user_id), então NÃO mandamos link cru do Stripe.
// =====================================================================
const supabase = require('../db/supabase');
const { enviarTexto } = require('./zapi');

const APP = 'https://www.forsora.com';

function RECUPERACAO_SIGNUP_TEXT(nome) {
  const ola = nome ? `Oi, ${String(nome).trim().split(' ')[0]}!` : 'Oi!';
  return [
    `${ola} 👋 Aqui é a *Sora* 💚`,
    ``,
    `Você deu o primeiro passo e criou sua conta — mas parou bem na reta final. Bora terminar agora?`,
    ``,
    `Imagina mandar *"gastei 50 no mercado"* aqui no WhatsApp e pronto: eu lanço, categorizo e te mostro exatamente pra onde seu dinheiro tá indo 📊 Sem planilha, sem app complicado. Só conversa.`,
    ``,
    `🎁 E pra te dar um empurrãozinho, separei um presente: *15% OFF* com o cupom *SORA15* no checkout — válido por *24 horas* ⏳😉`,
    ``,
    `É 2 minutinhos. Finaliza aqui:`,
    `🌐 ${APP}/login`,
    ``,
    `Te espero do outro lado pra organizar essa vida financeira! 🙌`,
  ].join('\n');
}

// 2º lembrete — mais agressivo (cupom SORA25, 25% OFF, 5h). "Última chance".
function RECUPERACAO_SIGNUP2_TEXT(nome) {
  const ola = nome ? `Oi, ${String(nome).trim().split(' ')[0]}!` : 'Oi!';
  return [
    `${ola} 👋 É a *Sora* de novo 💚`,
    ``,
    `Não quero que você perca isso — então vou de tudo ou nada: liberei *25% OFF* com o cupom *SORA25* no checkout, mas vale só pelas próximas *5 horas* ⏳`,
    ``,
    `É a sua chance de começar a organizar suas finanças no automático, direto no WhatsApp, pagando bem menos.`,
    ``,
    `Finaliza aqui antes que expire:`,
    `🌐 ${APP}/login`,
    ``,
    `Depois disso o desconto some 😬 Bora? 🙌`,
  ].join('\n');
}

// Manda a recuperação pra quem cadastrou e nunca pagou. `limite` = quantos por
// rodada (evita rajada no Z-API; o cron repete e drena o acúmulo aos poucos).
async function processarRecuperacaoSignup(limite = 50) {
  const agora = Date.now();
  const ate   = new Date(agora - 2 * 60 * 60 * 1000).toISOString();        // criado há >= 2h
  const desde = new Date(agora - 90 * 24 * 60 * 60 * 1000).toISOString();  // e <= 90 dias

  const { data: users, error } = await supabase.from('users')
    .select('id, name, phone, created_at')
    .eq('plano', 'inativo')
    .is('plano_intervalo', null)            // nunca teve assinatura ativa (≠ cancelou)
    .not('phone', 'is', null)
    .is('recuperacao_signup_em', null)      // ainda não recebeu
    .lte('created_at', ate)
    .gte('created_at', desde)
    .order('created_at', { ascending: false })
    .limit(limite);

  if (error) { console.log('[recuperacao signup] rode a migration 056:', error.message); return; }

  let enviados = 0;
  for (const u of users || []) {
    if (!u.phone) continue;
    // Marca ANTES de enviar — à prova de restart e não corre risco de spamar.
    await supabase.from('users').update({ recuperacao_signup_em: new Date().toISOString() }).eq('id', u.id);
    try {
      await enviarTexto(u.phone, RECUPERACAO_SIGNUP_TEXT(u.name));
      enviados++;
    } catch (e) {
      console.warn('[recuperacao signup] envio falhou', u.id, e.message);
    }
  }
  if (enviados) console.log(`💸 Recuperação de cadastro: ${enviados} enviado(s).`);
  return enviados;
}

// 2º lembrete: quem recebeu o 1º há >= 3 dias e ainda não pagou. Cupom SORA25.
async function processarRecuperacaoSignup2(limite = 50) {
  const agora = Date.now();
  const apos1o = new Date(agora - 3 * 24 * 60 * 60 * 1000).toISOString();    // 1º foi há >= 3 dias
  const desde  = new Date(agora - 120 * 24 * 60 * 60 * 1000).toISOString();  // não cutuca cadastros muito antigos

  const { data: users, error } = await supabase.from('users')
    .select('id, name, phone')
    .eq('plano', 'inativo')
    .is('plano_intervalo', null)                  // continua sem assinatura
    .not('phone', 'is', null)
    .not('recuperacao_signup_em', 'is', null)     // já recebeu o 1º
    .is('recuperacao_signup2_em', null)           // ainda não recebeu o 2º
    .lte('recuperacao_signup_em', apos1o)         // e o 1º foi há >= 3 dias
    .gte('created_at', desde)
    .order('recuperacao_signup_em', { ascending: true })
    .limit(limite);

  if (error) { console.log('[recuperacao signup 2] rode a migration 057:', error.message); return; }

  let enviados = 0;
  for (const u of users || []) {
    if (!u.phone) continue;
    await supabase.from('users').update({ recuperacao_signup2_em: new Date().toISOString() }).eq('id', u.id);
    try {
      await enviarTexto(u.phone, RECUPERACAO_SIGNUP2_TEXT(u.name));
      enviados++;
    } catch (e) {
      console.warn('[recuperacao signup 2] envio falhou', u.id, e.message);
    }
  }
  if (enviados) console.log(`💸 Recuperação de cadastro (2º): ${enviados} enviado(s).`);
  return enviados;
}

module.exports = {
  RECUPERACAO_SIGNUP_TEXT, processarRecuperacaoSignup,
  RECUPERACAO_SIGNUP2_TEXT, processarRecuperacaoSignup2,
};
