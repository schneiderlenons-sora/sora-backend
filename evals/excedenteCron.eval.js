// =============================================================================
// EVAL DE PONTA A PONTA — o JOB 1R avisa, espera o prazo, e só então desliga?
//
// ⚠️ ESTE ARQUIVO EXISTE PORQUE O EVAL DE FUNÇÃO PURA NÃO BASTA. Foi a lição do
// JOB 1J (30/09/2026): a regra pura passava, 8 mutações mortas, e o cron
// continuava engolindo o aviso — porque eu nunca havia EXECUTADO o job.
//
// Aqui o JOB 1R roda de verdade: banco falso, provedor falso, relógio congelado
// às 10:00 de São Paulo. O que está sob teste é a consequência: quem recebeu
// aviso, qual linha foi gravada, e QUAL conexão foi revogada.
//
// ⚠️ O risco desta feature é desligar o banco de quem não devia. Então metade
// dos cenários aqui é sobre NÃO desligar.
//
// Rodar: node evals/excedenteCron.eval.js
// =============================================================================
const path = require('path');
const Module = require('module');

const RAIZ = path.resolve(__dirname, '..');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://falso';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'falso';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-falso';

// ⚠️ Lido do modulo, nao cravado: o prazo ja mudou uma vez (48h -> 72h) e
// cravar o numero faz o eval falhar por motivo errado.
const { PRAZO_HORAS } = require('../src/services/excedenteConexoes');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };

const INSTANTE = '2026-10-02T13:05:00Z';   // 10:05 em São Paulo
const hAtras = (h) => new Date(Date.parse(INSTANTE) - h * 3600 * 1000).toISOString();

/**
 * Roda o JOB 1R com um cenário e devolve tudo que ele FEZ.
 *
 * @param usuario        linha de `users` (phone, of_excedente_desde, ...)
 * @param conexoes       linhas de `of_conexoes`
 * @param limite         o que `acessoOpenFinance` devolveria
 * @param erroUsers      true = o select de users erra (migration 179 pendente)
 * @param revogacaoFalha true = o provedor recusa revogar
 * @param cortar         valor de OF_EXCEDENTE_CORTAR
 */
function rodar({ usuario, conexoes, limite, erroUsers = false, revogacaoFalha = false, cortar = '1', instante = INSTANTE }) {
  const enviados = [];
  const updates = [];
  const deletados = [];
  const revogados = [];
  const historico = [];

  const fake = (nome) => {
    const q = {
      _patch: null, _del: false,
      select() { return q; }, eq(col, val) { if (q._del && col === 'id') q._delId = val; return q; },
      not() { return q; }, is() { return q; }, lt() { return q; }, gte() { return q; },
      lte() { return q; }, in() { return q; }, order() { return q; }, limit() { return q; },
      insert(p) { if (nome === 'of_conexoes_historico') historico.push(p); return q; },
      update(p) { updates.push({ t: nome, patch: p }); q._patch = p; return q; },
      delete() { q._del = true; return q; },
      maybeSingle: () => {
        if (nome === 'users') {
          return Promise.resolve(erroUsers
            ? { data: null, error: { message: 'column does not exist' } }
            : { data: usuario, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(res) {
        if (q._del) { deletados.push({ t: nome, id: q._delId }); return res({ data: null, error: null }); }
        if (q._patch) return res({ data: null, error: null });
        if (nome === 'of_conexoes') return res({ data: conexoes, error: null });
        return res({ data: [], error: null });
      },
    };
    return q;
  };

  const jobs = [];
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) return { from: fake };
    if (req.endsWith('config/openFinanceAccess')) {
      return {
        // `limite: null` simula falha de leitura do plano.
        acessoOpenFinance: async () => ({ liberado: limite > 0, limite, franquia: 0, pagas: 0, plano: 'premium', motivo: null }),
        liberadoOpenFinance: async () => true,
        LIMITE_CONEXOES: { basico: 1, premium: 3, platinum: 5 },
      };
    }
    // ⚠️ CASA O FIM DO CAMINHO, nao o prefixo `services/`. `desconectarConexao`
    // importa `./openFinanceProvider` (irmao), e com o matcher antigo o provedor
    // REAL era usado: o eval fazia chamada de rede e "revogou" sem revogar nada.
    if (/openFinanceProvider$/.test(req)) {
      const real = origLoad.call(this, req, parent, isMain);
      return {
        ...real,
        // ⚠️ `ehConexaoViva` tem de ser o REAL: é ele que decide a ordem de
        // corte, e trocá-lo por um stub testaria o stub.
        para: () => ({
          removerConexao: async (id) => {
            if (revogacaoFalha) throw new Error('provedor fora do ar');
            revogados.push(id);
          },
        }),
      };
    }
    if (req.endsWith('services/avisos')) {
      return { avisosLigados: async () => true, briefingLigado: async () => false, briefingCobriuCompromisso: () => false };
    }
    if (req.endsWith('services/proativo')) {
      return {
        provedor: () => 'zapi',
        enviarProativo: async (phone, o) => { enviados.push({ phone, ...o }); return true; },
        enviarProativoDetalhado: async (phone, o) => { enviados.push({ phone, ...o }); return { ok: true }; },
      };
    }
    if (req.endsWith('services/mensageiro')) return new Proxy({}, { get: () => async () => true });
    // ⚠️ SÓ O JOB 1R. Rodar os 20+ crons por cenário faz chamada de rede real
    // (cotações, Yahoo) e estoura o tempo. O filtro é pelo CORPO da função:
    // depender da ordem de registro quebraria ao inserir um cron novo.
    if (req === 'node-cron') {
      return {
        schedule: (_e, fn) => {
          if (/OF excedente/.test(String(fn))) jobs.push(fn);
          return { stop() {} };
        },
      };
    }
    return origLoad.call(this, req, parent, isMain);
  };

  // ⚠️ RELÓGIO CONGELADO: o job compara a hora de SP (só roda ~10:00) e calcula
  // o prazo a partir de agora. Sem fixar, o teste passaria conforme a hora.
  const RealDate = Date;
  const AGORA = new RealDate(instante);
  global.Date = class extends RealDate {
    constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(AGORA); }
    static now() { return AGORA.getTime(); }
  };
  global.Date.UTC = RealDate.UTC;
  global.Date.parse = RealDate.parse;

  const cortarAntes = process.env.OF_EXCEDENTE_CORTAR;
  process.env.OF_EXCEDENTE_CORTAR = cortar;
  const antes = process.cwd();
  process.chdir(RAIZ);

  // ⚠️ LIMPA O CACHE DE TODO `src/`: recarregando só o jobs, os módulos que ele
  // importa ficariam com o supabase falso do cenário ANTERIOR no fechamento.
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  }
  require(path.join(RAIZ, 'src/jobs/index.js'));
  Module._load = origLoad;

  return (async () => {
    if (!jobs.length) throw new Error('JOB 1R não encontrado — o filtro por "OF excedente" parou de casar.');
    for (const fn of jobs) await fn();
    global.Date = RealDate;
    process.chdir(antes);
    if (cortarAntes === undefined) delete process.env.OF_EXCEDENTE_CORTAR;
    else process.env.OF_EXCEDENTE_CORTAR = cortarAntes;
    return { enviados, updates, deletados, revogados, historico };
  })();
}

const U = (extra = {}) => ({
  id: 'u1', phone: '5532999990000', email: 'cliente@x.com', grupo_ativo: 'g1',
  of_excedente_desde: null, of_excedente_avisado: null, avisos_ativos: true, ...extra,
});
const CX = (id, extra = {}) => ({
  id: 'row-' + id, user_id: 'u1', grupo_id: 'g1', provider: 'polp-celcoin',
  external_id: id, instituicao: 'Banco ' + id, status: 'updated',
  ultima_sync: INSTANTE, created_at: '2026-01-01T00:00:00Z', ...extra,
});

const patchDe = (updates, campo) => updates.find((u) => u.t === 'users' && campo in u.patch);

(async () => {
  console.log('-- 1. dentro do direito: o job nao faz NADA --');
  {
    const r = await rodar({ usuario: U(), conexoes: [CX('a')], limite: 3 });
    eq(r.enviados.length, 0, '§1 ninguém é avisado');
    eq(r.deletados.length, 0, '§1 nada é apagado');
    eq(r.revogados.length, 0, '§1 nada é revogado');
    eq(r.updates.length, 0, '§1 e a linha do usuário não é tocada');
  }
  console.log('  ok');

  console.log('-- 2. 1o PASSE: grava o marco, avisa, e NAO desliga --');
  {
    // O caso do Thiago: vitalício, franquia 0, 1 conexão viva.
    const r = await rodar({ usuario: U(), conexoes: [CX('a')], limite: 0 });
    eq(r.enviados.length, 1, '§2 avisou uma vez');
    eq(typeof patchDe(r.updates, 'of_excedente_desde')?.patch.of_excedente_desde, 'string', '§2 gravou o marco');
    eq(r.deletados.length, 0, '§2 NAO desligou nada');
    eq(r.revogados.length, 0, '§2 nem revogou');
    const t = String(r.enviados[0]?.texto || '');
    // ⚠️ DERIVADO de PRAZO_HORAS, nao cravado: quando o prazo mudou de 48h
    // pra 72h este caso quebrou com "2 dias" literal — e o que importa e que o
    // texto diga o MESMO prazo que o corte vai usar, qualquer que ele seja.
    const diasDoPrazo = Math.floor(PRAZO_HORAS / 24);
    eq(new RegExp(diasDoPrazo + ' dias?').test(t), true, '§2 o texto diz o prazo real (' + diasDoPrazo + ' dias)');
    eq(/R\$ 6/.test(t), true, '§2 e oferece a conexão avulsa');
    eq(/desconecte um banco/i.test(t), true, '§2 e a outra saída');
  }
  console.log('  ok');

  console.log('-- 3. DEDUP: avisado hoje nao avisa de novo --');
  {
    // O cron roda a cada 15 min; sem dedup sairiam 4 avisos na mesma hora.
    const r = await rodar({
      usuario: U({ of_excedente_desde: hAtras(24), of_excedente_avisado: INSTANTE }),
      conexoes: [CX('a')], limite: 0,
    });
    eq(r.enviados.length, 0, '§3 não avisa duas vezes no mesmo dia');
    eq(r.deletados.length, 0, '§3 e ainda não desliga (24h de 48h)');
  }
  console.log('  ok');

  console.log('-- 4. ainda NO PRAZO (71h de 72): avisa de novo, nao desliga --');
  {
    const r = await rodar({
      usuario: U({ of_excedente_desde: hAtras(71), of_excedente_avisado: hAtras(24) }),
      conexoes: [CX('a')], limite: 0,
    });
    eq(r.enviados.length, 1, '§4 avisa de novo no dia seguinte');
    eq(/1h/.test(String(r.enviados[0]?.texto || '')), true, '§4 e diz quanto falta');
    eq(r.deletados.length, 0, '§4 NAO desliga dentro do prazo');
  }
  console.log('  ok');

  console.log('-- 5. PRAZO VENCIDO: desliga so o excedente, revogando antes --');
  {
    const r = await rodar({
      usuario: U({ of_excedente_desde: hAtras(73), of_excedente_avisado: hAtras(24) }),
      conexoes: [
        CX('velha', { created_at: '2026-01-01T00:00:00Z' }),
        CX('nova',  { created_at: '2026-09-01T00:00:00Z' }),
      ],
      limite: 1,
    });
    eq(r.revogados.join(','), 'nova', '§5 revogou a mais nova no provedor');
    eq(r.deletados.length, 1, '§5 e apagou UMA linha');
    eq(r.deletados[0].id, 'row-nova', '§5 a linha certa');
    eq(r.historico.length, 1, '§5 guardou no histórico');
    eq(r.historico[0].motivo, 'excedente', '§5 com o motivo');
  }
  console.log('  ok');

  console.log('-- 6. REVOGACAO FALHA: nao apaga a linha (tenta amanha) --');
  {
    // Apagar sem revogar perderia o rastro e a Polp seguiria cobrando — que é
    // exatamente o que este corte existe pra parar.
    const r = await rodar({
      usuario: U({ of_excedente_desde: hAtras(73), of_excedente_avisado: hAtras(24) }),
      conexoes: [CX('a')], limite: 0, revogacaoFalha: true,
    });
    eq(r.deletados.length, 0, '§6 NAO apagou a linha');
    eq(r.revogados.length, 0, '§6 e nada foi revogado');
  }
  console.log('  ok');

  console.log('-- 7. KILL SWITCH (OF_EXCEDENTE_CORTAR=0): avisa e nao corta --');
  {
    const r = await rodar({
      usuario: U({ of_excedente_desde: hAtras(73), of_excedente_avisado: hAtras(24) }),
      conexoes: [CX('a')], limite: 0, cortar: '0',
    });
    eq(r.enviados.length, 1, '§7 o aviso continua saindo');
    eq(r.deletados.length, 0, '§7 mas nada é desligado');
    eq(r.revogados.length, 0, '§7 nem revogado');
  }
  console.log('  ok');

  console.log('-- 8. MIGRATION 179 PENDENTE: o job nao age --');
  {
    // Sem as colunas o select erra. Agir aqui seria desligar às cegas, sem ter
    // como saber se a pessoa já foi avisada.
    const r = await rodar({
      usuario: U(), conexoes: [CX('a')], limite: 0, erroUsers: true,
    });
    eq(r.enviados.length, 0, '§8 não avisa');
    eq(r.deletados.length, 0, '§8 e NAO desliga');
    // ⚠️ ESTA LINHA NASCEU DE UMA MUTACAO SOBREVIVENTE: sem ela, remover o
    // `if (error) continue` passava no eval. O job seguia e GRAVAVA o marco a
    // partir de uma leitura que falhou — ou seja, agia sem ter lido.
    eq(r.updates.length, 0, '§8 e NAO ESCREVE NADA a partir de leitura que falhou');
  }
  console.log('  ok');

  console.log('-- 9. LIMITE NAO LIDO: nao desliga ninguem --');
  {
    // `acessoOpenFinance` sem limite numérico = não deu pra saber o direito.
    const r = await rodar({
      usuario: U({ of_excedente_desde: hAtras(99), of_excedente_avisado: hAtras(24) }),
      conexoes: [CX('a')], limite: null,
    });
    eq(r.deletados.length, 0, '§9 soluço na leitura do plano NAO desliga banco');
    eq(r.enviados.length, 0, '§9 nem avisa');
  }
  console.log('  ok');

  console.log('-- 10. REGULARIZOU: limpa o marco --');
  {
    const r = await rodar({
      usuario: U({ of_excedente_desde: hAtras(99), of_excedente_avisado: hAtras(24) }),
      conexoes: [CX('a')], limite: 1,
    });
    const p = patchDe(r.updates, 'of_excedente_desde');
    eq(p?.patch.of_excedente_desde, null, '§10 apagou o marco');
    eq(p?.patch.of_excedente_avisado, null, '§10 e o dedup do aviso');
    eq(r.deletados.length, 0, '§10 sem desligar nada');
  }
  console.log('  ok');

  console.log('-- 11. conexao SEM DONO nao conta e nao e tocada --');
  {
    // Linha legada sem `user_id`: não se mexe no que não se sabe de quem é.
    const r = await rodar({ usuario: U(), conexoes: [CX('orfa', { user_id: null })], limite: 0 });
    eq(r.enviados.length, 0, '§11 ninguém avisado');
    eq(r.deletados.length, 0, '§11 e a órfã não é desligada');
  }
  console.log('  ok');

  console.log('-- 12. FORA DA JANELA DAS 10:00 em SP o job nem roda --');
  {
    // A guarda de horario e o que evita 96 passes por dia. Sem testar um
    // instante fora da janela, remover a linha passaria no eval em silencio.
    const r = await rodar({ usuario: U(), conexoes: [CX('a')], limite: 0, instante: '2026-10-02T18:05:00Z' });
    eq(r.enviados.length, 0, '§12 as 15:05 em SP nao avisa');
    eq(r.updates.length, 0, '§12 nem grava marco');
  }
  {
    const r = await rodar({ usuario: U(), conexoes: [CX('a')], limite: 0, instante: '2026-10-02T13:20:00Z' });
    eq(r.enviados.length, 0, '§12 as 10:20 (fim da janela) tambem nao');
  }
  console.log('  ok');
  console.log('');
  if (falhas.length) {
    console.error(`x ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('OK excedenteCron: o JOB 1R avisa, espera o prazo, e so desliga o excedente');
  process.exit(0);
})().catch((e) => { console.error('x erro no eval:', e.message); process.exit(1); });
