// =============================================================================
// LEMBRETE DIÁRIO DAS TAREFAS EM ABERTO — o que entra e em que ordem.
//
// POR QUE EXISTE (01/10/2026). Pedido do cliente que relatou não receber
// avisos: "duas condições seriam interessantes: uma com lembrete diário e
// outra quando o prazo estiver chegando. Mas essa última você disse que é
// parecido com os compromissos — então se já existir essa possibilidade
// dentro dos compromissos eu posso usar essa função para tarefas".
//
// Ou seja: ele mesmo resolveu a segunda com compromissos. O que FALTAVA era o
// lembrete diário — nenhum cron tocava a tabela `tarefas`.
//
// ⚠️ TAREFA SEM PRAZO PRECISA ENTRAR. A tentação é listar só o que tem data,
// que é mais "limpo" — mas as 5 tarefas da conta dele têm `data_vencimento`
// nulo (tarefa criada pelo WhatsApp nasce sem data de propósito: frase com
// data vira compromisso). Um lembrete que só olha prazo entregaria uma
// mensagem vazia justamente pra quem pediu o recurso.
//
// ⚠️ MAS O PRAZO MANDA NA ORDEM. Atrasada primeiro, depois hoje, depois o que
// vence em breve, e só então o que não tem data. É o que faz a mensagem ser
// útil quando a lista é grande — e é também o que dá a ele, de graça, parte do
// "quando o prazo estiver chegando" que ele pediu, sem inventar um terceiro
// canal de aviso.
// =============================================================================

/** Quantas tarefas a mensagem mostra. 5 = `MAX_LISTA` dos templates do Loki. */
const LIMITE_PADRAO = 5;

/** Diferença em dias entre 'YYYY-MM-DD' e hoje, sem passar por fuso. */
function diasAte(dataStr, hojeStr) {
  if (!dataStr) return null;
  const a = Date.parse(`${String(dataStr).slice(0, 10)}T12:00:00Z`);
  const b = Date.parse(`${hojeStr}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

/**
 * Peso de ordenação: quanto MENOR, mais no topo.
 *
 * ⚠️ Sem prazo vai pro fim, nunca de fora. Ver o cabeçalho.
 */
function peso(dias) {
  if (dias === null) return 3;   // sem prazo
  if (dias < 0) return 0;        // atrasada
  if (dias === 0) return 1;      // vence hoje
  return 2;                      // vence em breve
}

/** Como a situação da tarefa é dita na mensagem. */
function situacaoDe(dias) {
  if (dias === null) return null;
  if (dias < 0) return dias === -1 ? 'atrasada 1 dia' : `atrasada ${Math.abs(dias)} dias`;
  if (dias === 0) return 'vence hoje';
  if (dias === 1) return 'vence amanhã';
  return `vence em ${dias} dias`;
}

/**
 * As tarefas que entram no lembrete de hoje, já ordenadas.
 *
 * @param tarefas  linhas de `tarefas` do usuário (qualquer estado)
 * @param hojeStr  'YYYY-MM-DD' em São Paulo
 * @returns { total, atrasadas, itens, ocultas }
 */
function tarefasDoLembrete({ tarefas, hojeStr, limite = LIMITE_PADRAO }) {
  const abertas = (tarefas || []).filter((t) => t && t.concluida !== true);

  const comPeso = abertas.map((t) => {
    const dias = diasAte(t.data_vencimento, hojeStr);
    return {
      id: t.id,
      titulo: String(t.titulo || '').trim() || 'Tarefa sem título',
      dias,
      peso: peso(dias),
      situacao: situacaoDe(dias),
      // `prioridade` é texto livre na tabela; serve só de desempate.
      prioridade: String(t.prioridade || '').toLowerCase(),
      criadoEm: t.created_at || '',
    };
  });

  const PRIO = { alta: 0, media: 1, média: 1, normal: 1, baixa: 2 };
  comPeso.sort((a, b) => {
    if (a.peso !== b.peso) return a.peso - b.peso;
    // Dentro do mesmo grupo: a data mais próxima primeiro.
    if (a.dias !== null && b.dias !== null && a.dias !== b.dias) return a.dias - b.dias;
    const pa = PRIO[a.prioridade] ?? 1;
    const pb = PRIO[b.prioridade] ?? 1;
    if (pa !== pb) return pa - pb;
    // Empate real: a mais antiga primeiro — é a que está esperando há mais tempo.
    return String(a.criadoEm).localeCompare(String(b.criadoEm));
  });

  const itens = comPeso.slice(0, Math.max(1, limite));
  return {
    total: comPeso.length,
    atrasadas: comPeso.filter((t) => t.peso === 0).length,
    itens,
    ocultas: Math.max(0, comPeso.length - itens.length),
  };
}

/** Uma linha da mensagem: "• Ligar pro gastro — atrasada 2 dias". */
function linhaDaTarefa(t) {
  return `• ${t.titulo}${t.situacao ? ` — ${t.situacao}` : ''}`;
}

/**
 * O texto do lembrete (versão rica, dentro da janela de 24h).
 * Fora dela o envio cai na cadeia de templates — ver `lembrete()` nos jobs.
 */
function textoDoLembrete(resumo, url) {
  const { total, atrasadas, itens, ocultas } = resumo;
  const plural = total === 1 ? 'tarefa' : 'tarefas';
  const cabecalho = atrasadas > 0
    ? `✅ *Suas tarefas*\n\nVocê tem *${total}* ${plural} em aberto — *${atrasadas}* ${atrasadas === 1 ? 'atrasada' : 'atrasadas'}.`
    : `✅ *Suas tarefas*\n\nVocê tem *${total}* ${plural} em aberto.`;
  const lista = itens.map(linhaDaTarefa).join('\n');
  const mais = ocultas > 0 ? `\n_…e mais ${ocultas}._` : '';
  return `${cabecalho}\n\n${lista}${mais}\n\n🌐 ${url}`;
}

/** Versão curta, de uma linha — é o que vai no parâmetro do template. */
function resumoCurto(resumo) {
  const { total, atrasadas, itens } = resumo;
  const plural = total === 1 ? 'tarefa' : 'tarefas';
  const nomes = itens.map((t) => t.titulo).join(' · ');
  const alerta = atrasadas > 0 ? ` (${atrasadas} atrasada${atrasadas === 1 ? '' : 's'})` : '';
  return `✅ ${total} ${plural} em aberto${alerta}: ${nomes}`;
}

module.exports = {
  tarefasDoLembrete, textoDoLembrete, resumoCurto, linhaDaTarefa,
  diasAte, situacaoDe, peso, LIMITE_PADRAO,
};
