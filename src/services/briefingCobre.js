// =============================================================================
// O BRIEFING MATINAL REALMENTE AVISOU SOBRE ESTE COMPROMISSO?
//
// POR QUE EXISTE (30/09/2026). Relato de cliente (Maurício): "não estou
// recebendo os avisos sobre tarefas ou lembretes agendados".
//
// O JOB 1J (lembrete de compromisso) suprime o aviso de QUALQUER compromisso de
// HOJE quando a pessoa tem o briefing matinal ligado, com a justificativa de
// que "o briefing já lista tudo de hoje na mesma mensagem" — e isso evitava uma
// duplicata real, relatada antes.
//
// ⚠️ MAS A PREMISSA SÓ VALE PARA O QUE JÁ EXISTIA QUANDO O BRIEFING SAIU.
// Reconstruído na conta do relato, em 30/09:
//
//   08:00  briefing do dia roda e marca `agenda_briefing_ultimo`
//   08:23  ele cria 3 compromissos (10:00, 10:00 e 11:00), lembrete 1h antes
//   09:00  JOB 1J vê "é de hoje + briefing ligado" → marca enviado e NÃO envia
//   10:00  idem
//
// Resultado: ele não recebeu nada. Nem o briefing (que rodou 23 minutos antes
// de os compromissos existirem, e portanto não os mencionou) nem o lembrete
// (suprimido em nome desse briefing). O compromisso marcado para daqui a uma
// hora e meia simplesmente não avisou.
//
// ⚠️ O ERRO ERA SUPOR COBERTURA EM VEZ DE CONFERIR. Aqui a pergunta passa a
// ser respondida com dado: o compromisso já existia no instante em que o
// briefing de hoje foi enviado?
// =============================================================================

const TZ = 'America/Sao_Paulo';

/**
 * Um instante (ISO/Date) como 'YYYY-MM-DD HH:mm' no fuso de São Paulo.
 *
 * ⚠️ Comparar assim, por TEXTO em SP, evita aritmética de offset. Cravar -3
 * seria uma bomba silenciosa se o país voltar a ter horário de verão — e o
 * Render roda em UTC, então o fuso do processo nunca é o certo.
 */
function instanteSP(valor) {
  // ⚠️ `new Date(null)` é 1970, não erro — e 1970 passaria como "criado muito
  // antes do briefing", afirmando uma cobertura que ninguém verificou. O eval
  // pegou exatamente isso.
  if (valor === null || valor === undefined || valor === '') return null;
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return null;
  // ⚠️ `hourCycle: 'h23'`, NÃO `hour12: false`. Os dois parecem a mesma coisa,
  // mas `hour12: false` deixa o ciclo a cargo do ICU e pode devolver "24:00"
  // para a meia-noite — e "2026-09-30 24:00" comparado como texto vem DEPOIS
  // de qualquer horário de briefing, invertendo a resposta justamente na
  // virada do dia. Com `h23` a meia-noite é "00" por contrato, e não sobra
  // uma guarda que nenhum teste consegue exercitar.
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).reduce((acc, x) => (acc[x.type] = x.value, acc), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * @param briefingUltimo  `users.agenda_briefing_ultimo` ('YYYY-MM-DD')
 * @param briefingHorario `users.agenda_briefing_horario` ('HH:mm')
 * @param criadoEm        `compromissos.created_at`
 * @param hojeStr         hoje em SP ('YYYY-MM-DD')
 * @param hora            `compromissos.hora` ('HH:mm') — null = dia todo
 * @param antecedencia    `compromissos.lembrete_antecedencia`, em minutos
 * @returns true só quando o briefing REALMENTE substitui este lembrete.
 *          `true` = pode suprimir.
 */
function briefingCobriu({ briefingUltimo, briefingHorario, criadoEm, hojeStr, hora, antecedencia }) {
  // ⚠️ COMPROMISSO COM HORA MARCADA E ANTECEDÊNCIA NUNCA É SUPRIMIDO.
  //
  // Segundo relato do mesmo cliente (01/10/2026). Ele marcou "Ligar para more"
  // às 11:00 com aviso 1h antes, às 07:15 — ou seja, ANTES do briefing das
  // 08:00. A regra abaixo então dizia "o briefing cobriu" e engolia o lembrete
  // das 10:00. A primeira correção (compromisso criado DEPOIS do briefing)
  // funcionou como projetado e mesmo assim ele não recebeu nada: eu tinha
  // corrigido a borda e deixado a premissa errada de pé.
  //
  // A premissa errada é tratar os dois avisos como a mesma coisa. Não são:
  //   briefing 08:00 → "hoje você tem isto" (panorama do dia)
  //   lembrete 10:00 → "é daqui a uma hora"  (o aviso acionável)
  //
  // E, acima de tudo, a Sora PROMETE o segundo na confirmação, com estas
  // palavras: "🔔 Te aviso 1h antes". Suprimir é quebrar uma promessa escrita
  // na tela do cliente — nenhuma economia de mensagem paga por isso.
  //
  // ⚠️ A proteção contra DUPLICATA que motivou este código continua de pé,
  // onde ela de fato existia: compromisso SEM hora (dia todo) cai em 09:00 por
  // padrão e, com antecedência 0, o lembrete não diz nada que o briefing já não
  // tenha dito. Esse segue suprimido.
  // ⚠️ BASTA TER HORA MARCADA. Cheguei a exigir também antecedência > 0, e a
  // mutação mostrou que a segunda condição não se sustenta: antecedência 0 com
  // hora quer dizer "me avise NA HORA" — é um pedido tão explícito quanto
  // "1h antes", e "são 11:00, é agora" não é a mesma informação que o briefing
  // das 08:00 deu. Quem tem hora marcada é avisado, ponto.
  const temHora = /^\d{1,2}:\d{2}/.test(String(hora || ''));
  if (temHora) return false;

  // O briefing de hoje ainda não saiu (ou falhou): não há cobertura nenhuma
  // para invocar, então o lembrete tem de sair.
  if (!briefingUltimo || briefingUltimo !== hojeStr) return false;

  // ⚠️ SEM `created_at` NÃO SE AFIRMA COBERTURA. Na dúvida o aviso sai: um
  // lembrete repetido incomoda, um lembrete que nunca chega faz a pessoa
  // perder o compromisso — e foi isso que gerou o relato.
  const criado = instanteSP(criadoEm);
  if (!criado) return false;

  const horario = /^\d{1,2}:\d{2}$/.test(String(briefingHorario || '')) ? briefingHorario : '08:00';
  const envio = `${hojeStr} ${String(horario).padStart(5, '0')}`;

  // Criado ATÉ o instante do briefing → ele estava na mensagem.
  return criado <= envio;
}

module.exports = { briefingCobriu, instanteSP };
