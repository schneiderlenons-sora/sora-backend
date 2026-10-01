// =============================================================================
// "MINHA AGENDA" NO WHATSAPP — que período, e como caber na mensagem.
//
// PEDIDO DE CLIENTE (30/09/2026): "seria interessante se o pedido para ver a
// agenda através do whatsapp retornasse os compromissos dos próximos 30 dias e
// não apenas 7 como está atualmente, pois isto facilitaria a programação
// pessoal para o mês inteiro".
//
// ⚠️ TROCAR O 7 POR 30 SOZINHO QUEBRARIA A RESPOSTA. `enviarBotaoLink` monta
// uma mensagem interativa, e o corpo dela é limitado a **1024 caracteres** pela
// Cloud API — o nosso envio faz `.slice(0, 1024)` e não avisa ninguém. Com 7
// dias isso quase nunca estourava; com 30 estoura, e a mensagem chega cortada
// no meio de uma linha, sem o cliente saber que faltou compromisso. Um mês de
// agenda truncado em silêncio é pior que uma semana completa.
//
// Por isso o corte mora aqui: sempre em LINHA INTEIRA, e sempre dizendo
// quantos ficaram de fora e onde vê-los.
//
// ⚠️ DATAS EM SÃO PAULO, NUNCA `toISOString()`. O Render roda em UTC: às 21h no
// Brasil o servidor já está no dia seguinte, e a agenda passava a esconder os
// compromissos de HOJE à noite — justamente quando alguém pergunta "o que eu
// tenho ainda hoje?". Medido: às 23h30 de 30/09 em SP, `new Date()` +
// `setHours(0,0,0,0)` + `toISOString()` devolvia 2026-10-01.
// =============================================================================

const TZ = 'America/Sao_Paulo';

/** 'YYYY-MM-DD' de hoje no fuso de São Paulo. */
function hojeSP(agora = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(agora);
}

/** Soma dias a uma data 'YYYY-MM-DD' sem passar por fuso nenhum. */
function somarDias(iso, dias) {
  const [a, m, d] = String(iso).split('-').map(Number);
  // Meio-dia UTC: longe o bastante das bordas pra o horário de verão de
  // qualquer fuso não empurrar o resultado pro dia vizinho.
  const base = new Date(Date.UTC(a, m - 1, d, 12));
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
}

/**
 * Quantos dias a pessoa pediu.
 *
 * ⚠️ A LISTA DE SUFIXOS É FECHADA, E ISSO NÃO É PREGUIÇA. O mesmo verbo CRIA
 * compromisso: "agenda dentista terça 15h" tem de continuar caindo no fluxo de
 * criação (`RE_AGENDA_DIRETO` em handlers/grow.js). Se este reconhecedor
 * aceitasse "agenda <qualquer coisa>", ele sequestraria a criação e a pessoa
 * receberia a lista em vez do compromisso marcado.
 */
const RE_AGENDA_CONSULTA = new RegExp(
  '^\\s*(?:minha\\s+agenda|agenda|meus\\s+compromissos|compromissos)'
  + '(?:\\s+(?:de|da|do|dos|das|para|pra|nos|nas|em))?'
  + '(?:\\s+(?:proximos?|proximas?|pr[oó]ximos?|pr[oó]ximas?))?'
  + '\\s*(hoje|amanha|amanh[ãa]|semana|esta\\s+semana|m[êe]s|este\\s+m[êe]s|\\d{1,3}\\s*dias?)?'
  + '\\s*(?:dias?)?\\s*[?!.]*$',
  'i',
);

/** Teto de dias. Mais que isso vira uma lista que ninguém lê no WhatsApp. */
const MAX_DIAS = 90;

/**
 * @returns `null` se a frase não é uma consulta de agenda, ou
 *          `{ dias, rotulo }` — `dias: 0` significa só hoje.
 */
function periodoDaFrase(msg) {
  const m = RE_AGENDA_CONSULTA.exec(String(msg || ''));
  if (!m) return null;
  const sufixo = String(m[1] || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

  if (!sufixo) {
    // ⚠️ O PADRÃO VIROU 30 DIAS — era 7, e é exatamente o que o cliente pediu.
    return { dias: 30, rotulo: 'nos próximos 30 dias' };
  }
  if (sufixo === 'hoje')   return { dias: 0, rotulo: 'de hoje' };
  if (sufixo === 'amanha') return { dias: 1, rotulo: 'até amanhã' };
  if (/semana/.test(sufixo)) return { dias: 7, rotulo: 'nos próximos 7 dias' };
  if (/mes/.test(sufixo))    return { dias: 30, rotulo: 'nos próximos 30 dias' };

  const n = parseInt(sufixo, 10);
  if (Number.isFinite(n) && n > 0) {
    const dias = Math.min(n, MAX_DIAS);
    return { dias, rotulo: `nos próximos ${dias} dias` };
  }
  return { dias: 30, rotulo: 'nos próximos 30 dias' };
}

/** A janela [de, ate] em datas 'YYYY-MM-DD', no fuso de São Paulo. */
function janela(dias, agora = new Date()) {
  const de = hojeSP(agora);
  return { de, ate: somarDias(de, dias) };
}

function rotuloDia(dataStr, hojeStr) {
  const diff = Math.round(
    (Date.parse(`${dataStr}T12:00:00Z`) - Date.parse(`${hojeStr}T12:00:00Z`)) / 86400000,
  );
  if (diff === 0) return 'Hoje';
  if (diff === 1) return 'Amanhã';
  const d = new Date(`${dataStr}T12:00:00Z`);
  return d.toLocaleDateString('pt-BR', {
    timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short',
  }).replace(/\./g, '');
}

/**
 * Limite do corpo de uma mensagem interativa na Cloud API. A folga é pro
 * rodapé "e mais N…", que só existe quando algo foi cortado.
 */
const LIMITE_CORPO = 1024;
const FOLGA_RODAPE = 90;

/**
 * Monta o texto da agenda, cabendo no limite.
 *
 * @param compromissos linhas de `compromissos` já filtradas e ordenadas
 * @param hojeStr      'YYYY-MM-DD' em SP
 * @returns { texto, mostrados, ocultos }
 */
function montarAgenda({ compromissos, hojeStr, titulo }) {
  const lista = compromissos || [];
  const porDia = new Map();
  for (const c of lista) {
    if (!porDia.has(c.data)) porDia.set(c.data, []);
    porDia.get(c.data).push(c);
  }

  const cabecalho = `${titulo}\n\n`;
  const blocos = [];
  let usado = cabecalho.length;
  let mostrados = 0;
  let cortou = false;

  for (const [dia, itens] of porDia) {
    const linhas = itens.map((c) =>
      `🕐 ${c.hora || 'dia todo'} — ${c.titulo}${c.local ? ` 📍 ${c.local}` : ''}`);
    const bloco = `*${rotuloDia(dia, hojeStr)}*\n${linhas.join('\n')}`;
    const custo = bloco.length + 2; // + '\n\n'

    // ⚠️ O CORTE É POR DIA INTEIRO. Cortar no meio de um dia deixaria metade
    // dos compromissos daquela data de fora com a data ainda na tela — quem lê
    // acreditaria que aquilo é tudo o que tem no dia.
    if (usado + custo > LIMITE_CORPO - FOLGA_RODAPE && blocos.length > 0) {
      cortou = true;
      break;
    }
    blocos.push(bloco);
    usado += custo;
    mostrados += itens.length;
  }

  const ocultos = lista.length - mostrados;
  let texto = cabecalho + blocos.join('\n\n');
  if (cortou && ocultos > 0) {
    texto += `\n\n_…e mais ${ocultos} ${ocultos === 1 ? 'compromisso' : 'compromissos'} no período. Veja tudo no painel._`;
  }

  return { texto, mostrados, ocultos: cortou ? ocultos : 0 };
}

module.exports = {
  hojeSP, somarDias, periodoDaFrase, janela, montarAgenda, rotuloDia,
  RE_AGENDA_CONSULTA, LIMITE_CORPO, MAX_DIAS,
};
