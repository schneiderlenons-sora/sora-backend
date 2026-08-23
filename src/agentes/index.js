// =============================================================================
// A VOZ dos agentes da Sora.
//
// Cada família de aviso tem um DONO — um personagem — e a mensagem passa a ser
// escrita na voz dele. Interruptor cinza é silenciado; recado de personagem é
// lido. O gatilho, o horário e o conteúdo continuam idênticos.
//
// ⚠️ A VOZ ENVOLVE O TEXTO, NUNCA O REESCREVE.
// A mensagem final é `assinatura + abertura + TEXTO ORIGINAL + fecho`. Isso é
// deliberado: se a personalidade reescrevesse o miolo, um valor ou uma data
// poderiam se perder na brincadeira — e aviso financeiro errado é pior do que
// aviso sem graça. Aqui o miolo é intocado por construção.
//
// LIGA/DESLIGA: `AGENTES_VOZ=1` no Render. Desligado (padrão) tudo sai
// exatamente como sai hoje — dá pra subir o código e revisar o tom antes.
//
// Espelha o catálogo do painel em `sora-frontend/lib/agentes.ts`: os `id` de
// agente e de aviso são os MESMOS nos dois lados.
// =============================================================================

const VOZ_LIGADA = process.env.AGENTES_VOZ === '1';

// ── Template com a CARA do agente (fase 3) ──────────────────────────────────
// A imagem do cabeçalho é parâmetro de ENVIO, não fica presa no template
// aprovado (services/whatsapp.js → opts.headerImage). Por isso UM template
// aprovado serve os 8 agentes, cada um mandando a sua foto — e agente novo
// entra sem passar pela revisão da Meta de novo.
//
// ⚠️ SÓ LIGAR DEPOIS QUE O FRONTEND ESTIVER EM PRODUÇÃO: a Meta busca a imagem
// pela URL pública, e os arquivos vivem em `public/agentes/` do painel. Com o
// branch ainda não mergeado, a URL dá 404 e a Meta recusa a mensagem inteira.
const TEMPLATE_LIGADO = process.env.AGENTES_TEMPLATE === '1';
const TPL_AGENTE = process.env.WHATSAPP_TPL_AGENTE || 'agente_aviso';
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL || 'https://www.forsora.com').replace(/\/$/, '');

// Limite de parâmetro de template da Meta é 1024; deixo folga porque o `core`
// vem de fora e pode crescer. Passando disso, o fecho é cortado (a informação
// fica; some só a piada).
const MAX_CORE = 900;

// `arte: false` = ainda não existe `public/agentes/whatsapp/<id>.png` no
// painel (a capa do WhatsApp, 1200×630 — pasta separada da arte do painel,
// que é 640×640/320×320 e serve outra finalidade, ver lib/agentes.ts). Sem
// arte cai na capa genérica da Sora, porque URL de imagem que dá 404 faz a
// Meta RECUSAR a mensagem inteira — o agente ficaria mudo por falta de
// desenho. Quando a arte chegar, é só virar pra `true`.
const AGENTES = {
  sardinha:            { nome: 'Sardinha',        emoji: '🐟', arte: true },
  'don-baleone':       { nome: 'Don Baleone',     emoji: '🐋', arte: true },
  // ⚠️ `capaVersao: 2` — a Meta buscou a URL do `sora.png` quando ela ainda
  // dava 404 (o arquivo tinha ficado sem commit no frontend) e parece ter
  // guardado essa falha em cache: mesmo depois do arquivo corrigido e
  // respondendo 200, o envio continuava sendo recusado com a MESMA URL.
  // `?v=2` força a Meta a tratar como uma URL nova e buscar de novo — não
  // muda o arquivo nem a imagem, só evita o cache da tentativa ruim.
  sora:             { nome: 'Sora',         emoji: '🎥', arte: true, capaVersao: 2 },
  loki:              { nome: 'Loki',          emoji: '🌅', arte: true },
  'dr-house':          { nome: 'Dr. House',       emoji: '🩺', arte: true },
  'detetive-watson':   { nome: 'Detetive Watson', emoji: '🔍', arte: true },
  osvaldo:             { nome: 'Osvaldo',         emoji: '💰', arte: true },
  oraculo:             { nome: 'Oráculo',         emoji: '🔮', arte: true },
};

// ── As falas ────────────────────────────────────────────────────────────────
// Chave = `<agente>.<aviso>`. `abre` entra antes do texto, `fecha` depois.
// 3–4 variações cada, sorteadas — a mesma frase toda semana vira ruído.
const VOZES = {
  // ── Sardinha: o vigia afobado das contas ──────────────────────────────
  'sardinha.recorrencias': {
    abre: ['Chefia! Passando o olho na agenda de hoje...',
           'Opa! Achei uma coisa que vence hoje.',
           'Corre aqui que tem conta batendo na porta.'],
    fecha: ['Se já pagou, me ignora que eu finjo que não falei nada.',
            'Marquei aqui pra não deixar passar.',
            'Tô de olho, pode seguir.'],
  },
  'sardinha.lembretes': {
    abre: ['Chefia, lembrete na área!', 'Ó, você me pediu pra avisar disso.',
           'Passando pra cobrar o que você mesmo mandou eu cobrar.'],
    fecha: ['Cumpri minha parte, o resto é com você.',
            'Anotado e avisado. 🐟', 'Tô só fazendo meu trabalho, viu.'],
  },
  'sardinha.parcelas': {
    abre: ['Parcela chegando, chefia.', 'Mais uma prestação batendo o ponto.',
           'Olha ela aí, pontual como sempre.'],
    fecha: ['Falta cada vez menos.', 'Uma a menos pra contar.',
            'Já já acaba, aguenta firme.'],
  },
  'sardinha.fatura': {
    abre: ['Fatura na área, chefia.', 'Notícia do cartão pra você.',
           'Passando o informe do cartão.'],
    fecha: ['Anota aí pra não esquecer.', 'Tô de olho no prazo por você.',
            'Qualquer coisa me chama.'],
  },

  // ── Don Baleone: puxa a orelha, nunca ofende ─────────────────────────
  'don-baleone.dividas': {
    abre: ['Escuta aqui, chefe...', 'Chefe. Uma palavrinha.',
           'Senta aqui que a gente precisa conversar.'],
    fecha: ['Não me faça mandar o Sardinha aí. 🤌',
            'Eu finjo que não vi. Uma vez.',
            'Resolve isso e a gente continua amigo. 🤌'],
  },
  'don-baleone.limite': {
    abre: ['Escuta aqui, chefe...', 'Chefe, isso aqui passou do ponto.',
           'Eu não queria ter que falar isso, mas...'],
    fecha: ['Da próxima, quem vai chorar é a sua conta bancária. 🤌',
            'Eu finjo que não vi. Uma vez.',
            'Segura a mão até o fim do mês, faz isso por mim.'],
  },

  // ── Detetive Watson: deduz em voz alta, sempre com a prova ────────────
  'detetive-watson.duplicadas': {
    abre: ['Elementar.', 'Uma observação, se me permite.',
           'Havia algo estranho nos seus registros.'],
    fecha: ['Duas entradas, uma compra só. O resto é dedução.',
            'Não acuso sem prova — e a prova está aí.',
            'Fica a seu critério, claro. Eu apenas noto.'],
  },

  // ── Sora: narrador de documentário ─────────────────────────────────
  // O resumo JÁ vem com manchete e frase próprias (gerarInsight). Aqui a voz
  // é só a moldura de quem está narrando — abertura curta, sem competir com
  // o texto que a IA escreveu.
  'sora.resumo-semanal': {
    abre: ['Sete dias observando você. O relatório:',
           'Encerrada a semana de observação.',
           'Mais um ciclo registrado. Vejamos:'],
    fecha: ['Seguimos acompanhando.', 'A expedição continua.',
            'Volto no próximo domingo.'],
  },
  'sora.resumo-mensal': {
    abre: ['Um mês inteiro de observação. O balanço:',
           'Fecha-se mais um ciclo. O que os dados contam:',
           'Trinta dias depois, o retrato:'],
    fecha: ['Um novo mês começa — e eu estarei aqui.',
            'Registrado para a posteridade.',
            'Até o próximo fechamento.'],
  },

  // ── Loki: o certinho debochado ─────────────────────────────────────────
  // Mantém tudo em ordem e ironiza de leve quando você esquece. Seco e curto,
  // nunca ofensivo — a piada é com a SITUAÇÃO, jamais com a pessoa.
  // Sem tratamento no feminino (sobra do nome antigo) e sem "bom dia": o
  // personagem é noturno; o briefing é o resumo que ele deixa pronto.
  'loki.briefing': {
    abre: ['Já organizei o seu dia. De nada.',
           'Enquanto você dormia, eu li sua agenda.',
           'Seu dia, resumido — porque alguém tinha que fazer isso.'],
    fecha: ['Eu cumpro a minha parte. A sua é sair da cama.',
            'Anotado e conferido. Agora é com você.',
            'Não me faça repetir tudo amanhã.'],
  },
  'loki.habitos': {
    abre: ['Faltou coisa na sua lista de hoje.',
           'Conferindo os hábitos. Alerta de spoiler: tem pendência.',
           'Você marcou quase tudo hoje. Quase.'],
    fecha: ['Dois toques e o dia fecha. Dois.',
            'Amanhã a gente finge que hoje foi perfeito.',
            'Não julgo. Só registro.'],
  },
  'loki.compromissos': {
    abre: ['Isso aqui está chegando, caso tenha esquecido.',
           'Lembrete que você jurou não precisar:',
           'Sua agenda tem uma opinião sobre o seu horário:'],
    fecha: ['Chegue no horário e me faça parecer bom nisso.',
            'Já estava anotado. Como sempre.',
            'O relógio é meu. O atraso seria seu.'],
  },
  'loki.manutencoes': {
    abre: ['Aquilo da casa continua ali, te encarando.',
           'Tarefa da casa vencida. De novo.',
           'A casa pediu pra lembrar. Não foi a primeira vez.'],
    fecha: ['Cinco minutos e você para de me dar trabalho.',
            'Resolve hoje e eu paro de falar nisso.',
            'Eu marco quando estiver feito. Se estiver.'],
  },

  // ── Dr. House: diagnóstico sarcástico, sempre certo ───────────────────
  'dr-house.medicamentos': {
    abre: ['Prescrição em atraso.', 'Vamos tentar de novo:', 'Hora da dose.'],
    fecha: ['Eu diria que pular invalida o tratamento, mas você já sabe disso.',
            'Todo mundo mente sobre ter tomado. Não seja todo mundo.',
            'Não é sugestão, é prescrição.'],
  },
  'dr-house.consultas': {
    abre: ['Anota na agenda antes que esqueça:', 'Diagnóstico da sua semana:',
           'Sua agenda médica não se organiza sozinha.'],
    fecha: ['Leve os exames. Não, eles não estão "em algum lugar".',
            'Aparecer é metade do tratamento.',
            'Chegue no horário. Eu sei que você já pensou em remarcar.'],
  },
};

// ── Sorteio estável ─────────────────────────────────────────────────────────
// Seed opcional deixa o eval determinístico e evita repetir a mesma abertura
// pro mesmo item no mesmo dia.
function hash(s) {
  let h = 0;
  for (let i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
  return Math.abs(h);
}
const escolher = (lista, seed) =>
  lista[(seed == null ? Math.floor(Math.random() * lista.length) : hash(seed)) % lista.length];

/**
 * Veste um aviso com a voz do agente dono.
 *
 * @param {string} agenteId  'don-baleone' | 'sardinha' | ...
 * @param {string} avisoId   'dividas' | 'limite' | ...
 * @param {{texto?: string, core?: string, seed?: string}} msg
 *        `texto` = mensagem rica (Z-API / dentro da janela de 24h)
 *        `core`  = versão de UMA linha usada como parâmetro do template
 * @returns {{texto: string, core: string}} — devolve o original quando a voz
 *          está desligada ou quando não existe fala pra esse aviso.
 */
function falar(agenteId, avisoId, { texto = '', core = '', seed } = {}) {
  const voz = VOZES[`${agenteId}.${avisoId}`];
  const agente = AGENTES[agenteId];
  if (!VOZ_LIGADA || !voz || !agente) return { texto, core };

  const s = seed == null ? null : `${agenteId}.${avisoId}.${seed}`;
  const abre = escolher(voz.abre, s);
  const fecha = escolher(voz.fecha, s == null ? null : `${s}.f`);
  const nome = `${agente.emoji} *${agente.nome}*`;

  const textoNovo = `${nome}\n_${abre}_\n\n${texto}\n\n_${fecha}_`;

  // O core vai como parâmetro de template: UMA linha e com teto de tamanho.
  const baseCore = core || texto;
  const comFecho = `${agente.emoji} ${agente.nome}: ${abre} ${baseCore} ${fecha}`;
  const semFecho = `${agente.emoji} ${agente.nome}: ${abre} ${baseCore}`;
  const coreNovo = comFecho.length <= MAX_CORE ? comFecho : semFecho;

  // `coreAgente` = o MESMO recado SEM o "emoji Nome:" na frente. É o que vai no
  // template `agente_aviso`, onde o nome já é o {{1}} e a foto é o cabeçalho —
  // repetir o nome no corpo ficaria "Don Baleone: Don Baleone: ...".
  const agComFecho = `${abre} ${baseCore} ${fecha}`;
  const coreAgente = agComFecho.length <= MAX_CORE ? agComFecho : `${abre} ${baseCore}`;

  return { texto: textoNovo, core: coreNovo, coreAgente };
}

/**
 * Título do aviso — o {{1}} do template `agente_aviso`.
 *
 * ⚠️ ISTO NÃO PRECISA DE APROVAÇÃO DA META. O corpo do template é fixo
 * ("🐋 Recado da tripulação: {{1}}") e mudá-lo exige submeter modelo novo,
 * mas o CONTEÚDO do {{1}} é nosso. Antes ia só o nome do agente, então todo
 * aviso chegava igual: "Recado da tripulação: Loki". Agora o assunto vem
 * junto e a pessoa sabe do que se trata antes de abrir.
 *
 * Cada chave é `agente.aviso`, as MESMAS de VOZES — se a voz existe, o
 * título existe. Sem entrada, cai no nome do agente (comportamento antigo).
 */
const TITULO_AVISO = {
  'sardinha.recorrencias':     'Conta fixa vencendo',
  'sardinha.lembretes':        'Lembrete',
  'sardinha.parcelas':         'Parcela vencendo',
  'sardinha.fatura':           'Fatura do cartão',
  'don-baleone.dividas':       'Dívida vencendo',
  'don-baleone.limite':        'Limite de gasto',
  'detetive-watson.duplicadas':'Cobrança repetida',
  'sora.resumo-semanal':       'Resumo da semana',
  'sora.resumo-mensal':        'Fechamento do mês',
  'loki.briefing':             'Sua agenda de hoje',
  'loki.habitos':              'Hábitos de hoje',
  'loki.compromissos':         'Compromisso chegando',
  'loki.manutencoes':          'Manutenção da casa',
  'dr-house.medicamentos':     'Hora do remédio',
  'dr-house.consultas':        'Consulta marcada',
};

/** `Assunto · Agente` — o assunto primeiro, que é o que a pessoa lê antes de
 *  decidir se abre. Sem título cadastrado, só o nome (como era). */
function tituloDe(agenteId, avisoId) {
  const agente = AGENTES[agenteId];
  const t = TITULO_AVISO[`${agenteId}.${avisoId}`];
  if (!agente) return t || '';
  return t ? `${t} · ${agente.nome}` : agente.nome;
}
/**
 * Template com a foto e o nome do agente, pro envio FORA da janela de 24h.
 *
 * Devolve `null` quando a fase 3 está desligada ou o agente é desconhecido —
 * aí quem chama cai no `lembretes_gerais` de sempre.
 *
 * @param {string} agenteId
 * @param {string} core  recado em UMA linha, já sem o nome do agente
 */
function templateAgente(agenteId, core, avisoId) {
  const agente = AGENTES[agenteId];
  if (!TEMPLATE_LIGADO || !agente || !core) return null;
  return {
    name: TPL_AGENTE,
    // {{1}} ASSUNTO · agente  ·  {{2}} o recado na voz dele
    params: [tituloDe(agenteId, avisoId), String(core).replace(/\s*[\r\n\t]+\s*/g, ' ').trim().slice(0, MAX_CORE)],
    // A Meta EXIGE o parâmetro de header em todo envio quando o template tem
    // cabeçalho de mídia — senão recusa e o aviso não chega. Agente sem arte
    // usa a capa da Sora (ver `arte` no catálogo).
    //
    // ⚠️ `whatsapp/` é pasta SEPARADA de `public/agentes/<id>.png` (essa é a
    // arte do painel — poster do vídeo, 640×640). A capa de mensagem tem
    // dimensão PRÓPRIA (1200×630, o formato que o WhatsApp/Meta espera pra
    // preview de link/cabeçalho) — arquivo errado aqui não é "meio certo", a
    // Meta corta ou recusa a imagem inteira.
    opts: {
      headerImage: agente.arte
        // `?v=N` (ver `capaVersao` no catálogo) só existe pra "descachear" uma
        // URL que a Meta já tentou buscar e falhou (404 anterior). Sem
        // capaVersao, a URL não leva query — comportamento de sempre.
        ? `${APP_URL}/agentes/whatsapp/${agenteId}.png${agente.capaVersao ? `?v=${agente.capaVersao}` : ''}`
        : (process.env.SORA_CAPA_URL || `${APP_URL}/sora-capa.png`),
    },
  };
}

/** O aviso tem dono com fala pronta? (usado pelo eval e pelo diagnóstico) */
const temVoz = (agenteId, avisoId) => !!VOZES[`${agenteId}.${avisoId}`];

module.exports = {
  tituloDe,
  falar, temVoz, templateAgente, AGENTES, VOZES, VOZ_LIGADA, TEMPLATE_LIGADO,
};
