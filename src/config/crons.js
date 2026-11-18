// =============================================================================
// TRAVA DOS CRONS — `CRONS_ATIVOS=0` sobe o servidor SEM NENHUM agendamento.
//
// Existe pra MUDAR O BACKEND DE LUGAR (nov/2026: Render de Oregon pra Ohio, a
// região do Supabase). O Render não troca a região de um serviço: é preciso
// subir um SEGUNDO serviço e, por um tempo, os dois ficam no ar. Sem esta
// trava, os dois rodariam os 24 crons — e o lembrete de remédio, que guarda o
// "já mandei" só na MEMÓRIA do processo, sairia em DOBRO pra todo mundo (o
// mesmo vale pra qualquer job cuja dedup não esteja no banco).
//
// Webhooks não precisam de trava: Meta, Celcoin e a Vercel apontam pra UM
// endereço só. Quem duplica é o que o servidor faz SOZINHO, ou seja, os crons.
//
// ⚠️ SEM A VARIÁVEL (ou vazia) = LIGADOS. É o estado de hoje em produção, e
// esta trava não pode mudar nada pra quem não a configurar.
//
// ⚠️ VALOR NÃO RECONHECIDO = DESLIGADOS (com aviso no log). Quem escreveu
// alguma coisa ali quis mexer na chave; um "O" (letra) no lugar de "0" ligando
// os crons no servidor antigo é exatamente o lembrete em dobro que a trava
// existe pra evitar. O estado real aparece em GET /health (`crons`).
//
// Comparação sem caixa e sem espaço: o `WHATSAPP_PROVIDER=META` maiúsculo já
// deixou a Sora muda por um dia (CLAUDE.md, migração da Cloud API).
// =============================================================================

const LIGA = new Set(['1', 'true', 'sim', 'on', 'yes']);
const DESLIGA = new Set(['0', 'false', 'nao', 'não', 'off', 'no']);

/** Os crons deste processo devem rodar? Fonte única — jobs/index.js e /health. */
function cronsLigados(env = process.env) {
  const bruto = env.CRONS_ATIVOS;
  if (bruto == null) return true;
  const v = String(bruto).trim().toLowerCase();
  if (v === '' || LIGA.has(v)) return true;
  if (DESLIGA.has(v)) return false;
  return false; // não reconhecido → desligado (ver cabeçalho)
}

/** O valor está fora das listas? (pra o log avisar em vez de calar) */
function valorReconhecido(env = process.env) {
  const bruto = env.CRONS_ATIVOS;
  if (bruto == null) return true;
  const v = String(bruto).trim().toLowerCase();
  return v === '' || LIGA.has(v) || DESLIGA.has(v);
}

module.exports = { cronsLigados, valorReconhecido };
