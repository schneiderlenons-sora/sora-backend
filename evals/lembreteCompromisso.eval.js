// =============================================================================
// EVAL DE PONTA A PONTA — o cron de lembrete de compromisso ENVIA mesmo, e
// NA HORA prometida?
//
// ⚠️ ESTE ARQUIVO EXISTE PORQUE O EVAL DE FUNÇÃO PURA NÃO BASTOU.
//
// Em 30/09/2026 corrigi o lembrete que sumia, validei a regra com
// `briefingCobre.eval.js`, 8 mutações mortas, e dei por testado. No dia
// seguinte o mesmo cliente relatou que continuava sem receber — e estava
// certo: a função pura respondia certo para o caso que eu tinha em mente, e o
// CRON continuava engolindo o aviso no caso dele. Eu nunca havia executado o
// job.
//
// Aqui o JOB 1J roda de verdade: banco falso, relógio congelado, e os dados
// REAIS das contas dos relatos. O teste só passa se a mensagem sair.
//
// ⚠️ TERCEIRO RELATO (16/11/2026): "notificação para as 18:50, não recebi
// nada" — chamado aberto às 18:54. O job rodava de 15 em 15 e o aviso saiu às
// 19:00, na hora do compromisso (a Meta confirma a entrega). §5 em diante.
//
// Rodar:  node evals/lembreteCompromisso.eval.js
// =============================================================================
const path = require('path');
const Module = require('module');

const RAIZ = path.resolve(__dirname, '..');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-falso';

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

/**
 * Roda o cron inteiro com um cenário e devolve o que foi enviado.
 * @param instanteUTC  quando o relógio é congelado
 * @param envio        resposta do envio na Meta: 'ok' | 'recusa' | 'ambigua'
 * @param reserva      false = outra rodada já reservou a linha
 * @param rodadas      quantas vezes o job roda (mesma carga de módulo)
 * @param usuarioQueLanca  user_id cuja leitura de telefone LANÇA erro
 */
function rodarCron({ usuario, compromissos, instanteUTC, envio = 'ok', reserva = true, rodadas = 1, usuarioQueLanca = null }) {
  const enviados = [];
  const tentativas = [];
  const updates = [];
  const agendas = [];

  const fake = (nome) => {
    const q = {
      _patch: null, _eqs: [], _sel: false,
      select() { if (q._patch) q._sel = true; return q; },
      eq(col, val) { q._eqs.push([col, val]); return q; },
      not() { return q; }, is() { return q; }, lt() { return q; }, gte() { return q; },
      lte() { return q; }, in() { return q; }, order() { return q; }, limit() { return q; },
      maybeSingle: () => {
        const id = (q._eqs.find(([c]) => c === 'id') || [])[1];
        if (nome === 'users' && usuarioQueLanca && id === usuarioQueLanca) return Promise.reject(new Error('falha de rede simulada'));
        return Promise.resolve({ data: nome === 'users' ? usuario : null, error: null });
      },
      update(p) { q._patch = p; return q; },
      then(res, rej) {
        if (q._patch) {
          const condicional = q._eqs.some(([c, v]) => c === 'lembrete_enviado' && v === false);
          updates.push({ t: nome, patch: q._patch, condicional, id: (q._eqs.find(([c]) => c === 'id') || [])[1] });
          // A reserva atômica é o UPDATE condicional com `.select()`.
          if (q._sel) return Promise.resolve({ data: reserva ? [{ id: 'x' }] : [], error: null }).then(res, rej);
          return Promise.resolve({ data: null, error: null }).then(res, rej);
        }
        if (nome === 'compromissos') return Promise.resolve({ data: compromissos, error: null }).then(res, rej);
        return Promise.resolve({ data: [], error: null }).then(res, rej);
      },
    };
    return q;
  };

  const jobs = [];
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) return { from: fake };
    if (req.endsWith('services/proativo')) {
      return {
        // 'ok' usa o trilho 'zapi' (texto rico, legível no teste). Recusa e
        // ambígua passam pela cadeia de modelos da Meta, que é onde elas existem.
        provedor: () => (envio === 'ok' ? 'zapi' : 'meta'),
        enviarProativo: async (phone, o) => { enviados.push({ phone, ...o }); return true; },
        enviarProativoDetalhado: async (phone, o) => {
          tentativas.push({ phone, template: o.template && o.template.name });
          if (envio === 'recusa') return { ok: false, falhaDeModelo: true, code: 132001 };
          if (envio === 'ambigua') return { ok: false, falhaDeModelo: false, code: 131000 };
          enviados.push({ phone, ...o }); return { ok: true };
        },
      };
    }
    if (req.endsWith('services/mensageiro')) {
      return new Proxy({}, { get: () => async () => true });
    }
    // ⚠️ SÓ O JOB 1J. Executar os 21 crons por cenário faz chamada de rede de
    // verdade (cotações, Yahoo) e o eval estourava o tempo — além de misturar
    // o barulho dos outros jobs no resultado. O filtro é pelo CORPO da função:
    // depender da ordem de registro quebraria ao inserir um cron novo.
    if (req === 'node-cron') {
      return {
        schedule: (expr, fn, opts) => {
          if (/Lembrete compromisso/.test(String(fn))) { jobs.push(fn); agendas.push({ expr, opts }); }
          return { stop() {} };
        },
      };
    }
    return origLoad.call(this, req, parent, isMain);
  };

  // ⚠️ RELÓGIO CONGELADO. O job compara a hora de SP com a do compromisso;
  // sem fixar o instante, o teste passaria ou falharia conforme a hora em que
  // alguém o rodasse.
  const RealDate = Date;
  const AGORA = new RealDate(instanteUTC);
  global.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(AGORA); }
    static now() { return AGORA.getTime(); }
  };
  global.Date.UTC = RealDate.UTC;
  global.Date.parse = RealDate.parse;

  const antes = process.cwd();
  process.chdir(RAIZ);

  // ⚠️ LIMPA O CACHE DE TODO `src/`, NÃO SÓ DO jobs/index.js.
  //
  // Isto custou uma hora de caça. Recarregando apenas o jobs, os módulos que
  // ele importa — `services/avisos.js` à frente — continuavam em cache com o
  // SUPABASE FALSO DO CENÁRIO ANTERIOR capturado no fechamento. Resultado: o
  // cenário 4 lia o usuário do cenário 1 (que tem briefing ligado) e o aviso
  // era suprimido. O código estava certo; o teste é que mentia.
  //
  // E `services/avisos.js` ainda tem cache PRÓPRIO por usuário (TTL), que
  // sobreviveria entre cenários pelo mesmo motivo.
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  }

  require(path.join(RAIZ, 'src/jobs/index.js'));
  Module._load = origLoad;

  return (async () => {
    if (!jobs.length) throw new Error('JOB 1J não foi encontrado — o filtro por "Lembrete compromisso" parou de casar.');
    // Silencia os avisos do próprio job (são esperados nos cenários de falha).
    const [w, e] = [console.warn, console.error];
    console.warn = () => {}; console.error = () => {};
    // Erro que escapa do job é capturado como o node-cron faz em produção
    // (loga e segue) — e o cenário vê o que deixou de sair por causa dele.
    try {
      for (let i = 0; i < rodadas; i++) for (const fn of jobs) { try { await fn(); } catch { /* rodada abortada */ } }
    } finally { console.warn = w; console.error = e; }
    global.Date = RealDate;
    process.chdir(antes);
    return { enviados, tentativas, updates, agendas };
  })();
}

const USUARIO = {
  id: 'u-maur', phone: '5511999126161', grupo_ativo: 'g1',
  agenda_briefing_ativo: true, agenda_briefing_horario: '08:00',
  agenda_briefing_ultimo: '2026-10-01',   // o briefing JÁ saiu hoje
  avisos_ativos: true,
};

// Dados REAIS do terceiro relato (16/11/2026). Briefing às 07:00, já rodado;
// compromisso criado às 13:42 de SP para as 19:00, aviso 10 min antes.
const USUARIO_JUH = {
  id: 'u-juh', phone: '5586994713880', grupo_ativo: 'g2',
  agenda_briefing_ativo: true, agenda_briefing_horario: '07:00',
  agenda_briefing_ultimo: '2026-11-16', avisos_ativos: true,
};
const LUCIANO = {
  id: 'c-luciano', grupo_id: 'g2', user_id: 'u-juh', titulo: 'Falar com Luciano',
  hora: '19:00', local: 'Sobre a missa do João Marcelo', data: '2026-11-16',
  lembrete_antecedencia: 10, lembrete_ativo: true, lembrete_enviado: false,
  created_at: '2026-11-16T16:42:58Z', // 13:42 em SP
};
const SP = (hhmm) => `2026-11-16T${String(Number(hhmm.slice(0, 2)) + 3).padStart(2, '0')}:${hhmm.slice(3)}:00Z`;
const textoDe = (m) => String(m.texto || '');

(async () => {
  console.log('── 0. A REGRA DE TEMPO (função pura) ──');
  {
    const { decidirLembrete, quandoTexto, antecedenciaDe } = require(path.join(RAIZ, 'src/services/lembreteCompromisso'));
    const sp = (m) => ({ dataStr: '2026-11-16', minutos: m });
    const h = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
    eq(decidirLembrete(LUCIANO, sp(h('18:49'))), 'esperar', '§0 18:49: ainda não');
    eq(decidirLembrete(LUCIANO, sp(h('18:50'))), 'enviar', '⚠️ §0 18:50: É A HORA (10 min antes)');
    eq(decidirLembrete(LUCIANO, sp(h('19:59'))), 'enviar', '§0 até 59 min depois do início ainda avisa');
    eq(decidirLembrete(LUCIANO, sp(h('20:00'))), 'expirado', '§0 1h depois do início: desiste');
    eq(decidirLembrete({ ...LUCIANO, lembrete_antecedencia: 0 }, sp(h('18:59'))), 'esperar', '§0 "na hora": 18:59 ainda não');
    eq(decidirLembrete({ ...LUCIANO, lembrete_antecedencia: 0 }, sp(h('19:00'))), 'enviar', '§0 "na hora": 19:00');
    eq(decidirLembrete({ ...LUCIANO, lembrete_antecedencia: null }, sp(h('17:59'))), 'esperar', '§0 sem antecedência = 60 min');
    eq(decidirLembrete({ ...LUCIANO, lembrete_antecedencia: null }, sp(h('18:00'))), 'enviar', '§0 sem antecedência = 60 min (18:00)');
    eq(antecedenciaDe({ lembrete_antecedencia: -5 }), 60, '§0 antecedência negativa não vira "depois do evento"');
    // "1 dia antes": gatilho na véspera.
    const amanha = { ...LUCIANO, data: '2026-11-17', lembrete_antecedencia: 1440 };
    eq(decidirLembrete(amanha, sp(h('18:59'))), 'esperar', '§0 1 dia antes: 18:59 da véspera ainda não');
    eq(decidirLembrete(amanha, sp(h('19:00'))), 'enviar', '§0 1 dia antes: 19:00 da véspera');
    // Dia todo = 09:00.
    const diaTodo = { ...LUCIANO, hora: null, lembrete_antecedencia: 0 };
    eq(decidirLembrete(diaTodo, sp(h('08:59'))), 'esperar', '§0 dia todo: base 09:00');
    eq(decidirLembrete(diaTodo, sp(h('09:00'))), 'enviar', '§0 dia todo: 09:00');
    // Virada do dia: 23:30 de ontem, avisado 00:10 de hoje.
    eq(decidirLembrete({ ...LUCIANO, data: '2026-11-15', hora: '23:30', lembrete_antecedencia: 0 }, sp(h('00:10'))), 'enviar', '§0 virada do dia');
    eq(quandoTexto(LUCIANO, '2026-11-16'), 'hoje às 19:00', '§0 texto hoje');
    eq(quandoTexto(amanha, '2026-11-16'), 'amanhã às 19:00', '§0 texto amanhã');
    eq(quandoTexto({ ...LUCIANO, data: '2026-11-15', hora: '23:30' }, '2026-11-16'), 'ontem às 23:30', '§0 nunca "amanhã" pro de ontem');
    eq(quandoTexto({ ...LUCIANO, hora: '19:00:00' }, '2026-11-16'), 'hoje às 19:00', '§0 hora com segundos sai HH:MM');
    eq(quandoTexto(diaTodo, '2026-11-16'), 'hoje', '§0 dia todo sem hora no texto');
  }
  console.log('  ok');

  console.log('── 1. ⚠️ O CASO DO RELATO: 11:00, aviso 1h antes, criado 07:15 ──');
  {
    // Dados REAIS da conta (01/10/2026). Criado ANTES do briefing das 08:00 —
    // era exatamente o que a regra antiga usava pra engolir o lembrete.
    const r = await rodarCron({
      usuario: USUARIO,
      compromissos: [{
        id: 'c1', grupo_id: 'g1', user_id: 'u-maur', titulo: 'Ligar para more',
        hora: '11:00', local: null, data: '2026-10-01', lembrete_antecedencia: 60,
        lembrete_ativo: true, lembrete_enviado: false,
        created_at: '2026-10-01T10:15:00Z', // 07:15 em SP
      }],
      instanteUTC: '2026-10-01T13:00:00Z',  // 10:00 em SP — a hora do aviso
    });
    const saiu = r.enviados.some((m) => textoDe(m).includes('Ligar para more'));
    eq(saiu, true, '⚠️ §1 O LEMBRETE DAS 10:00 TEM DE SAIR (era aqui que sumia)');
    eq(r.enviados.length, 1, '§1 uma mensagem, não duas');
    eq(r.updates.some((u) => u.t === 'compromissos' && u.patch?.lembrete_enviado === true && u.condicional), true,
      '§1 e marca como enviado (reserva condicional), pra não repetir no ciclo seguinte');
  }
  console.log('  ok');

  console.log('── 2. ANTES DA HORA, NADA SAI ──');
  {
    const r = await rodarCron({
      usuario: USUARIO,
      compromissos: [{
        id: 'c1', grupo_id: 'g1', user_id: 'u-maur', titulo: 'Ligar para more',
        hora: '11:00', data: '2026-10-01', lembrete_antecedencia: 60,
        lembrete_ativo: true, lembrete_enviado: false,
        created_at: '2026-10-01T10:15:00Z',
      }],
      instanteUTC: '2026-10-01T12:00:00Z',  // 09:00 em SP — falta uma hora
    });
    eq(r.enviados.length, 0, '§2 às 09:00 ainda não é hora de avisar');
    eq(r.updates.length, 0, '§2 e não marca nada');
  }
  console.log('  ok');

  console.log('── 3. A PROTEÇÃO CONTRA DUPLICATA CONTINUA ──');
  {
    // Dia todo, sem antecedência: o lembrete não diz nada que o briefing já
    // não tenha dito. Era a duplicata que motivou a supressão.
    const r = await rodarCron({
      usuario: USUARIO,
      compromissos: [{
        id: 'c2', grupo_id: 'g1', user_id: 'u-maur', titulo: 'Aniversário da Ana',
        hora: null, data: '2026-10-01', lembrete_antecedencia: 0,
        lembrete_ativo: true, lembrete_enviado: false,
        created_at: '2026-09-28T12:00:00Z',
      }],
      // ⚠️ 09:30 em SP. Às 10:00 o dia todo (base 09:00) já está "expirado" e
      // o cenário nunca chegava à supressão — passava por outro motivo. Achado
      // pela mutação que ignora a supressão e sobrevivia (nov/2026).
      instanteUTC: '2026-10-01T12:30:00Z',
    });
    eq(r.enviados.length, 0, '§3 dia todo + briefing ligado: segue suprimido');
    eq(r.updates.some((u) => u.patch?.lembrete_enviado === true), true, '§3 e marca, pra não voltar a cada minuto');
  }
  console.log('  ok');

  console.log('── 4. SEM BRIEFING, O DIA TODO VOLTA A AVISAR ──');
  {
    const r = await rodarCron({
      usuario: { ...USUARIO, agenda_briefing_ativo: false, agenda_briefing_ultimo: null },
      compromissos: [{
        id: 'c2', grupo_id: 'g1', user_id: 'u-maur', titulo: 'Aniversário da Ana',
        hora: null, data: '2026-10-01', lembrete_antecedencia: 0,
        lembrete_ativo: true, lembrete_enviado: false,
        created_at: '2026-09-28T12:00:00Z',
      }],
      // ⚠️ 09:30 em SP, não 10:00. Evento "dia todo" usa 09:00 como base, e o
      // job desiste do que passou há mais de 1h — às 10:00 em ponto ele já
      // estaria fora da janela por igualdade, e o teste falharia por um
      // cenário mal escolhido, não por defeito no código.
      instanteUTC: '2026-10-01T12:30:00Z',
    });
    eq(r.enviados.length, 1, '§4 sem briefing não há o que suprimir');
  }
  console.log('  ok');

  console.log('── 5. ⚠️ TERCEIRO RELATO: "10 min antes" sai às 18:50, não às 19:00 ──');
  {
    const r = await rodarCron({ usuario: USUARIO_JUH, compromissos: [LUCIANO], instanteUTC: SP('18:50') });
    eq(r.enviados.length, 1, '⚠️ §5 às 18:50 o aviso SAI (antes saía só às 19:00)');
    eq(r.enviados.some((m) => textoDe(m).includes('hoje às 19:00')), true, '§5 diz "hoje às 19:00"');
    eq(r.enviados[0] && r.enviados[0].phone, '5586994713880', '§5 vai pro telefone do dono do compromisso');
    const antes = await rodarCron({ usuario: USUARIO_JUH, compromissos: [LUCIANO], instanteUTC: SP('18:49') });
    eq(antes.enviados.length, 0, '§5 às 18:49 ainda não');
    eq(r.agendas[0] && r.agendas[0].expr, '* * * * *', '⚠️ §5 o job roda A CADA MINUTO');
    eq(!!(r.agendas[0] && r.agendas[0].opts && r.agendas[0].opts.noOverlap), true, '§5 e sem sobreposição de rodadas');
  }
  console.log('  ok');

  console.log('── 6. RESERVA ATÔMICA: quem não reservou não envia ──');
  {
    const r = await rodarCron({ usuario: USUARIO_JUH, compromissos: [LUCIANO], instanteUTC: SP('18:50'), reserva: false });
    eq(r.enviados.length, 0, '§6 outra rodada já reservou: nada sai daqui');
  }
  console.log('  ok');

  console.log('── 7. META RECUSA O MODELO: a reserva é desfeita e tenta de novo ──');
  {
    const r1 = await rodarCron({ usuario: USUARIO_JUH, compromissos: [LUCIANO], instanteUTC: SP('18:50'), envio: 'recusa' });
    eq(r1.enviados.length, 0, '§7 nada saiu');
    eq(r1.updates.some((u) => u.patch?.lembrete_enviado === false && u.id === 'c-luciano'), true,
      '⚠️ §7 a marca é DESFEITA (antes o aviso sumia em silêncio)');
    eq(r1.tentativas.length >= 1, true, '§7 tentou de fato');

    // Três rodadas: tenta, tenta, desiste — nunca fica tentando pra sempre.
    const r3 = await rodarCron({ usuario: USUARIO_JUH, compromissos: [LUCIANO], instanteUTC: SP('18:50'), envio: 'recusa', rodadas: 3 });
    const liberou = r3.updates.filter((u) => u.patch?.lembrete_enviado === false).length;
    eq(liberou, 2, '§7 libera nas 2 primeiras recusas e desiste na 3ª');
  }
  console.log('  ok');

  console.log('── 8. FALHA AMBÍGUA: não repete (pode ter saído) ──');
  {
    const r = await rodarCron({ usuario: USUARIO_JUH, compromissos: [LUCIANO], instanteUTC: SP('18:50'), envio: 'ambigua' });
    eq(r.tentativas.length, 1, '§8 uma tentativa só');
    eq(r.updates.some((u) => u.patch?.lembrete_enviado === false), false, '§8 a marca fica: duas mensagens iguais são pior');
  }
  console.log('  ok');

  console.log('── 9. UM COMPROMISSO COM ERRO NÃO DERRUBA OS OUTROS ──');
  {
    const ruim = { ...LUCIANO, id: 'c-ruim', user_id: 'u-quebra', titulo: 'Quebra' };
    const r = await rodarCron({
      usuario: USUARIO_JUH, compromissos: [ruim, LUCIANO], instanteUTC: SP('18:50'),
      usuarioQueLanca: 'u-quebra',
    });
    eq(r.enviados.some((m) => textoDe(m).includes('Falar com Luciano')), true, '⚠️ §9 o segundo aviso sai mesmo com o primeiro lançando erro');
  }
  console.log('  ok');

  console.log('── 10. PASSOU DA HORA: desiste sem enviar, e só se ninguém pegou ──');
  {
    const r = await rodarCron({ usuario: USUARIO_JUH, compromissos: [LUCIANO], instanteUTC: SP('20:00') });
    eq(r.enviados.length, 0, '§10 1h depois do início não manda');
    eq(r.updates.some((u) => u.patch?.lembrete_enviado === true && u.condicional), true, '§10 marca, condicionalmente');
  }
  console.log('  ok');

  console.log('');
  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ lembreteCompromisso (ponta a ponta): o cron envia de verdade, no minuto certo');
  // ⚠️ SAÍDA EXPLÍCITA. Carregar `jobs/index.js` registra 21 crons e abre
  // handles (cotações, Yahoo) que seguram o processo vivo para sempre — o
  // eval terminava os testes e nunca encerrava.
  process.exit(0);
})();
