// =============================================================================
// EVAL DE PONTA A PONTA — o cron de lembrete de compromisso ENVIA mesmo?
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
// Aqui o JOB 1J roda de verdade: banco falso, relógio congelado às 10:00 de
// São Paulo, e os dados REAIS da conta do relato. O teste só passa se a
// mensagem sair.
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
 * @param instanteUTC quando o relógio é congelado
 */
function rodarCron({ usuario, compromissos, instanteUTC }) {
  const enviados = [];
  const updates = [];

  const fake = (nome) => {
    const q = {
      _patch: null,
      select() { return q; }, eq() { return q; }, not() { return q; },
      is() { return q; }, lt() { return q; }, gte() { return q; },
      lte() { return q; }, in() { return q; }, order() { return q; }, limit() { return q; },
      maybeSingle: () => Promise.resolve({ data: nome === 'users' ? usuario : null, error: null }),
      update(p) { updates.push({ t: nome, patch: p }); q._patch = p; return q; },
      then(res) {
        if (q._patch) return res({ data: null, error: null });
        if (nome === 'compromissos') return res({ data: compromissos, error: null });
        return res({ data: [], error: null });
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
        // 'zapi' manda o TEXTO rico, sem passar pela cadeia de templates da
        // Meta — é o caminho que deixa a mensagem legível neste teste.
        provedor: () => 'zapi',
        enviarProativo: async (phone, o) => { enviados.push({ phone, ...o }); return true; },
        enviarProativoDetalhado: async (phone, o) => { enviados.push({ phone, ...o }); return { ok: true }; },
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
        schedule: (_e, fn) => {
          if (/Lembrete compromisso/.test(String(fn))) jobs.push(fn);
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
    for (const fn of jobs) await fn();
    global.Date = RealDate;
    process.chdir(antes);
    return { enviados, updates };
  })();
}

const USUARIO = {
  id: 'u-maur', phone: '5511999126161', grupo_ativo: 'g1',
  agenda_briefing_ativo: true, agenda_briefing_horario: '08:00',
  agenda_briefing_ultimo: '2026-10-01',   // o briefing JÁ saiu hoje
  avisos_ativos: true,
};

(async () => {
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
    const saiu = r.enviados.some((m) => String(m.texto || '').includes('Ligar para more'));
    eq(saiu, true, '⚠️ §1 O LEMBRETE DAS 10:00 TEM DE SAIR (era aqui que sumia)');
    eq(r.enviados.length, 1, '§1 uma mensagem, não duas');
    eq(r.updates.some((u) => u.t === 'compromissos' && u.patch?.lembrete_enviado), true,
      '§1 e marca como enviado, pra não repetir no ciclo seguinte');
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
      instanteUTC: '2026-10-01T13:00:00Z',
    });
    eq(r.enviados.length, 0, '§3 dia todo + briefing ligado: segue suprimido');
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

  console.log('');
  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ lembreteCompromisso (ponta a ponta): o cron envia de verdade');
  // ⚠️ SAÍDA EXPLÍCITA. Carregar `jobs/index.js` registra 21 crons e abre
  // handles (cotações, Yahoo) que seguram o processo vivo para sempre — o
  // eval terminava os testes e nunca encerrava.
  process.exit(0);
})();
