// =============================================================================
// Lembrete de COMPROMISSO da Agenda — QUANDO avisar.
//
// Fonte única da aritmética de tempo do JOB 1J (`jobs/index.js`).
// Travado em `npm run eval:lembrete-compromisso`.
//
// ⚠️ POR QUE O JOB RODA A CADA MINUTO (nov/2026). Ele rodava de 15 em 15 e a
// regra era "já passou do gatilho? manda". Com gatilho fora de :00/:15/:30/:45
// o aviso só saía na rodada seguinte: "10 min antes" de um compromisso das
// 19:00 (gatilho 18:50) saía às 19:00 — NA HORA do compromisso. Relato de
// cliente, 16/11: abriu o chamado às 18:54 dizendo que não recebeu nada; o
// aviso saiu às 19:00 e a Meta confirma a entrega. Medido: 32 dos 232
// lembretes com hora da base tinham o gatilho fora do quarto de hora.
//
// Os dois consertos anteriores (30/09 e 01/10) mexeram em OUTRA porta — a
// supressão pelo briefing — e esta continuou aberta.
// =============================================================================

/** Dias desde a época, pra fazer conta de minutos sem fuso. */
function diasEpoch(dataStr) {
  const [y, mo, d] = String(dataStr).slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(y, mo - 1, d) / 86400000);
}

/** Antecedência em minutos; ausente/inválida = 60 (o padrão de sempre). */
function antecedenciaDe(c) {
  return Number.isInteger(c.lembrete_antecedencia) && c.lembrete_antecedencia >= 0
    ? c.lembrete_antecedencia : 60;
}

/**
 * Minuto absoluto do evento. Dia todo (sem hora) usa 09:00 como base.
 */
function minutoDoEvento(c) {
  const [hh, mm] = c.hora ? String(c.hora).split(':').map(Number) : [9, 0];
  return diasEpoch(c.data) * 1440 + (hh * 60 + (mm || 0));
}

/** Quanto depois do início ainda vale avisar. Passou disso, desiste. */
const TOLERANCIA_DEPOIS_MIN = 60;

/**
 * O que fazer com este compromisso AGORA.
 *
 * @param c   linha de `compromissos` (data, hora, lembrete_antecedencia)
 * @param sp  `{ dataStr: 'YYYY-MM-DD', minutos: 0..1439 }` — relógio de SP
 * @returns {'esperar'|'enviar'|'expirado'}
 */
function decidirLembrete(c, sp) {
  const agora = diasEpoch(sp.dataStr) * 1440 + sp.minutos;
  const evento = minutoDoEvento(c);
  if (agora >= evento + TOLERANCIA_DEPOIS_MIN) return 'expirado';
  if (agora < evento - antecedenciaDe(c)) return 'esperar';
  return 'enviar';
}

/**
 * "hoje às 19:00" / "amanhã" — nunca "hoje" pra compromisso de amanhã.
 * O de ontem aparece na virada da meia-noite (23:30 avisado às 00:10).
 */
function quandoTexto(c, hojeStr) {
  const d = String(c.data).slice(0, 10);
  const dia = d === hojeStr ? 'hoje' : d > hojeStr ? 'amanhã' : 'ontem';
  return c.hora ? `${dia} às ${String(c.hora).slice(0, 5)}` : dia;
}

module.exports = { diasEpoch, antecedenciaDe, minutoDoEvento, decidirLembrete, quandoTexto, TOLERANCIA_DEPOIS_MIN };
