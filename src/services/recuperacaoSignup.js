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
const { enviarTexto } = require('./mensageiro');
const { enviarProativo } = require('./proativo');

const APP = 'https://www.forsora.com';

// Link da recuperação: volta pro checkout do vitalício certo se houver intenção
// (com cupom, rec=1 → passa pelo login se preciso). Senão, /login genérico.
// `intent` vem de users.vitalicio_intent (pode ser null → cai no /login).
function linkRecuperacao(intent, cupom = 'SORA15') {
  const tier = ['kit', 'completa', 'upgrade'].includes(intent) ? intent : null;
  return tier
    ? `${APP}/checkout-vitalicio?tier=${tier}&cupom=${cupom}&rec=1`
    : `${APP}/login`;
}

// Busca as intenções de vitalício de um lote de ids (tolerante: sem a migration
// 064, retorna vazio → cai no /login).
async function fetchIntents(ids) {
  const map = {};
  if (!ids || !ids.length) return map;
  try {
    const { data } = await supabase.from('users').select('id, vitalicio_intent').in('id', ids);
    for (const r of data || []) map[r.id] = r.vitalicio_intent || null;
  } catch { /* migration 064 pendente */ }
  return map;
}

function RECUPERACAO_SIGNUP_TEXT(nome, link = `${APP}/login`) {
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
    `🌐 ${link}`,
    ``,
    `Te espero do outro lado pra organizar essa vida financeira! 🙌`,
  ].join('\n');
}

// 2º lembrete — mais agressivo (cupom SORA25, 25% OFF, 5h). "Última chance".
function RECUPERACAO_SIGNUP2_TEXT(nome, link = `${APP}/login`) {
  const ola = nome ? `Oi, ${String(nome).trim().split(' ')[0]}!` : 'Oi!';
  return [
    `${ola} 👋 É a *Sora* de novo 💚`,
    ``,
    `Não quero que você perca isso — então vou de tudo ou nada: liberei *25% OFF* com o cupom *SORA25* no checkout, mas vale só pelas próximas *5 horas* ⏳`,
    ``,
    `É a sua chance de começar a organizar suas finanças no automático, direto no WhatsApp, pagando bem menos.`,
    ``,
    `Finaliza aqui antes que expire:`,
    `🌐 ${link}`,
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

  const intents = await fetchIntents((users || []).map((u) => u.id));

  let enviados = 0;
  for (const u of users || []) {
    if (!u.phone) continue;
    // Marca ANTES de enviar — à prova de restart e não corre risco de spamar.
    await supabase.from('users').update({ recuperacao_signup_em: new Date().toISOString() }).eq('id', u.id);
    try {
      const primeiro = (u.name || '').split(' ')[0] || 'oi';
      await enviarProativo(u.phone, {
        texto: RECUPERACAO_SIGNUP_TEXT(u.name, linkRecuperacao(intents[u.id], 'SORA15')),  // Z-API / dentro da janela
        template: { name: 'recuperacao_pagamento', params: [primeiro] },                   // Cloud API fora da janela
      });
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

  const intents = await fetchIntents((users || []).map((u) => u.id));

  let enviados = 0;
  for (const u of users || []) {
    if (!u.phone) continue;
    await supabase.from('users').update({ recuperacao_signup2_em: new Date().toISOString() }).eq('id', u.id);
    try {
      // TODO: o 2º lembrete (SORA25) ainda é texto livre → na Cloud API só entrega
      // DENTRO da janela de 24h. Pra alcançar lead frio, criar um template
      // `recuperacao_pagamento_2` (SORA25) na Meta e trocar por enviarProativo.
      await enviarTexto(u.phone, RECUPERACAO_SIGNUP2_TEXT(u.name, linkRecuperacao(intents[u.id], 'SORA25')));
      enviados++;
    } catch (e) {
      console.warn('[recuperacao signup 2] envio falhou', u.id, e.message);
    }
  }
  if (enviados) console.log(`💸 Recuperação de cadastro (2º): ${enviados} enviado(s).`);
  return enviados;
}

// ── Quando o lead RESPONDE no WhatsApp (já recebeu recuperação de cadastro) ──
// Está em recuperação de cadastro? (criou conta, recebeu o nudge, nunca pagou)
function emRecuperacaoCadastro(user) {
  return !!(user && user.recuperacao_signup_em);
}

// Resposta no tom certo: "você JÁ tem conta, finalize no login + cupom".
// Cupom acompanha o estágio: quem já recebeu o 2º vê SORA25; senão SORA15.
function respostaRecuperacaoCadastro(user) {
  const ola = user?.name ? `Oi, ${String(user.name).trim().split(' ')[0]}!` : 'Oi!';
  const cupomCode = user?.recuperacao_signup2_em ? 'SORA25' : 'SORA15';
  const cupom = user?.recuperacao_signup2_em ? '*SORA25* (25% OFF)' : '*SORA15* (15% OFF)';
  const link = linkRecuperacao(user?.vitalicio_intent, cupomCode);
  return [
    `${ola} 💚 Que bom te ver por aqui!`,
    ``,
    `Sua conta já está criada — falta só *ativar o plano* pra eu começar a organizar suas finanças aqui no WhatsApp. Não precisa criar de novo, é só entrar e finalizar:`,
    `🌐 ${link}`,
    ``,
    `🎁 E aproveita o cupom ${cupom} no checkout 😉`,
    ``,
    `Qualquer dúvida sobre os planos ou sobre o que eu faço, é só perguntar! 🙌`,
  ].join('\n');
}

// Nota pra IA responder a dúvida no tom de recuperação de cadastro.
function notaIaRecuperacaoCadastro(user) {
  const cupomCode = user?.recuperacao_signup2_em ? 'SORA25' : 'SORA15';
  const cupom = user?.recuperacao_signup2_em ? 'SORA25 = 25% de desconto' : 'SORA15 = 15% de desconto';
  const link = linkRecuperacao(user?.vitalicio_intent, cupomCode);
  return `OBS: este lead JÁ tem conta criada, mas nunca ativou o plano. Responda a dúvida de forma útil e SEMPRE convide a FINALIZAR entrando em ${link} (NÃO mande criar conta nova). Mencione o cupom ${cupom}. Tom acolhedor e persuasivo.`;
}

module.exports = {
  RECUPERACAO_SIGNUP_TEXT, processarRecuperacaoSignup,
  RECUPERACAO_SIGNUP2_TEXT, processarRecuperacaoSignup2,
  emRecuperacaoCadastro, respostaRecuperacaoCadastro, notaIaRecuperacaoCadastro,
};
