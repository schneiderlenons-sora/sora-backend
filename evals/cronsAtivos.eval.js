// =============================================================================
// EVAL — a TRAVA DOS CRONS (`CRONS_ATIVOS`, config/crons.js) segura MESMO?
//
// Ela existe pra trocar o backend de região (Render Oregon → Ohio): os dois
// servidores ficam no ar por um tempo, e só UM pode mandar lembrete. Se a
// trava falhar calada, o lembrete de remédio (dedup só em memória) sai em
// DOBRO pra todo mundo. Por isso o teste carrega o jobs/index.js DE VERDADE —
// com agendador e banco falsos — e conta quantos crons chegam ao node-cron.
//
// Rodar:  node evals/cronsAtivos.eval.js
// =============================================================================
const path = require('path');
const Module = require('module');

const RAIZ = path.resolve(__dirname, '..');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-falso';

const falhas = [];
let casos = 0;
const eq = (a, b, m) => { casos++; if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

// ── §1 A regra do valor ──────────────────────────────────────────────────────
const { cronsLigados, valorReconhecido } = require(path.join(RAIZ, 'src/config/crons'));
const tabela = [
  // sem a variável = LIGADOS: é o estado de hoje e não pode mudar
  [undefined, true, true],
  ['', true, true],
  ['  ', true, true],
  ['1', true, true],
  ['true', true, true],
  ['TRUE', true, true],
  ['Sim', true, true],
  [' on ', true, true],
  ['0', false, true],
  [' 0 ', false, true],
  ['false', false, true],
  ['FALSE', false, true],
  ['nao', false, true],
  ['Não', false, true],
  ['off', false, true],
  // não reconhecido = DESLIGADO, e o log avisa
  ['O', false, false],        // letra O no lugar do zero
  ['desligado', false, false],
  ['2', false, false],
];
for (const [v, ligado, reconhecido] of tabela) {
  const env = v === undefined ? {} : { CRONS_ATIVOS: v };
  eq(cronsLigados(env), ligado, `§1 cronsLigados(${JSON.stringify(v)})`);
  eq(valorReconhecido(env), reconhecido, `§1 valorReconhecido(${JSON.stringify(v)})`);
}

// ── §2 O jobs/index.js real, carregado com agendador falso ───────────────────
function carregarJobs(valor) {
  const agendados = [];
  const logs = [];
  const origLoad = Module._load;
  const fake = () => {
    const q = new Proxy({}, {
      get: (_t, k) => (k === 'then'
        ? (res) => Promise.resolve({ data: [], error: null }).then(res)
        : () => q),
    });
    return q;
  };
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) return { from: fake, rpc: fake };
    if (req.endsWith('services/mensageiro')) return new Proxy({}, { get: () => async () => true });
    if (req.endsWith('services/proativo')) {
      return { provedor: () => 'zapi', enviarProativo: async () => true, enviarProativoDetalhado: async () => ({ ok: true }) };
    }
    if (req === 'node-cron') {
      return { schedule: (expr) => { agendados.push(expr); return { stop() {} }; } };
    }
    return origLoad.call(this, req, parent, isMain);
  };
  const origLog = console.log; const origWarn = console.warn;
  console.log = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  const antes = process.env.CRONS_ATIVOS;
  if (valor === undefined) delete process.env.CRONS_ATIVOS; else process.env.CRONS_ATIVOS = valor;
  const cwd = process.cwd();
  process.chdir(RAIZ);
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  }
  try {
    require(path.join(RAIZ, 'src/jobs/index.js'));
  } finally {
    Module._load = origLoad;
    console.log = origLog; console.warn = origWarn;
    process.chdir(cwd);
    if (antes === undefined) delete process.env.CRONS_ATIVOS; else process.env.CRONS_ATIVOS = antes;
  }
  return { agendados, logs };
}

const ligado = carregarJobs(undefined);
const TOTAL = ligado.agendados.length;
eq(TOTAL >= 20, true, `§2 sem a variável os crons são agendados (vieram ${TOTAL})`);
eq(ligado.logs.some((l) => l.includes(`Crons LIGADOS: ${TOTAL} agendamentos`)), true, '§2 log diz LIGADOS com a contagem certa');
eq(ligado.agendados.includes('* * * * *'), true, '§2 o cron de minuto (remédio/compromisso) está entre os agendados');

const com1 = carregarJobs('1');
eq(com1.agendados.length, TOTAL, '§2 CRONS_ATIVOS=1 agenda todos');

const desligado = carregarJobs('0');
eq(desligado.agendados.length, 0, '§2 CRONS_ATIVOS=0 NÃO agenda nenhum');
eq(desligado.logs.some((l) => l.includes(`Crons DESLIGADOS`) && l.includes(`${TOTAL} agendamentos ignorados`)), true, '§2 log diz DESLIGADOS e quantos foram ignorados');
eq(desligado.logs.some((l) => l.includes('não reconhecido')), false, '§2 valor válido não gera aviso');

const letraO = carregarJobs('O');
eq(letraO.agendados.length, 0, '§2 valor torto ("O") NÃO liga os crons');
eq(letraO.logs.some((l) => l.includes('não reconhecido')), true, '§2 valor torto gera aviso no log');

const maiusculo = carregarJobs('FALSE');
eq(maiusculo.agendados.length, 0, '§2 FALSE maiúsculo desliga');

// ── resultado ────────────────────────────────────────────────────────────────
if (falhas.length) {
  console.log(`❌ ${falhas.length} de ${casos} casos falharam:`);
  for (const f of falhas) console.log('  - ' + f);
  process.exit(1);
}
console.log(`✅ eval:crons-ativos — ${casos} casos (${TOTAL} crons no arquivo)`);
