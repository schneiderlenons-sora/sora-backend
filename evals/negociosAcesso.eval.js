// =============================================================================
// EVAL — quem alcança o quê nas ROTAS da aba Negócios (fase 2 do multiusuário).
//
// Isto não é cálculo: um erro aqui não vira número torto na tela, vira o
// financeiro de uma loja editando o caixa de outra — ou um dono perdendo a
// própria empresa. Por isso passa pelas ROTAS DE VERDADE (routes/negocios.js)
// com um Supabase falso, e cada regra tem caso positivo E negativo.
//
// O que trava:
//   1. REGRESSÃO ZERO: sem a 173 (tabela inexistente), o dono vê e faz
//      exatamente o que fazia antes. É a garantia de que o deploy pode ir ao
//      ar com a migration ainda não rodada.
//   2. O membro convidado alcança a empresa e EDITA o que o dono lançou — era
//      o `.eq('user_id', user.id)` que impedia isso.
//   3. O estranho não alcança nada, nem sabendo o id da linha.
//   4. Papéis: leitura lê e não escreve; operador escreve e não renomeia a
//      empresa; arquivar é só do dono.
//   5. As SEIS rotas que não conferiam dono NENHUM (furo que já estava em
//      produção) passaram a conferir.
//   6. O custo órfão (empresa_id null) continua visível pro dono.
//   7. Insert de custo/integração grava `empresa_id`.
//   8. Invalidar snapshot do DRE é por EMPRESA, não por usuário.
//
// Rodar:  npm run eval:negocios-acesso
// =============================================================================
const path = require('path');

const falhas = [];
const eq = (a, b, m) => { if (a !== b) falhas.push(`${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`); };
const ok = (c, m) => { if (!c) falhas.push(m); };

// ── Supabase falso ───────────────────────────────────────────────────────────
// `semTabela` simula a 173 não rodada: a tabela responde erro de schema, que é
// exatamente o que o PostgREST devolve.
function criarBanco(inicial, { semTabela = [] } = {}) {
  const tabelas = JSON.parse(JSON.stringify(inicial));
  let seq = 0;

  // Só as duas formas que o código usa de verdade — parser de `.or()` amplo
  // seria mais código de teste do que de produção.
  function filtroOr(expr) {
    const mEq = /^empresa_id\.eq\.([^,]+),and\(empresa_id\.is\.null,user_id\.eq\.(.+)\)$/.exec(expr);
    if (!mEq) throw new Error(`or() não suportado no fake: ${expr}`);
    const [, empId, userId] = mEq;
    return (r) => r.empresa_id === empId || ((r.empresa_id ?? null) === null && r.user_id === userId);
  }

  function from(nome) {
    const filtros = [];
    let modo = 'select', payload = null, unica = null, embed = null, conflito = null;
    const api = {
      select(cols) {
        // `empresa_membros` traz a empresa embutida — o fake hidrata à mão.
        if (typeof cols === 'string' && /empresas\s*\(/.test(cols)) embed = 'empresas';
        return api;
      },
      insert(p) { modo = 'insert'; payload = p; return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      upsert(p, o) { modo = 'upsert'; payload = p; conflito = o?.onConflict || null; return api; },
      delete() { modo = 'delete'; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      is(c, v) { filtros.push((r) => (r[c] ?? null) === v); return api; },
      in(c, arr) { const s = new Set(arr); filtros.push((r) => s.has(r[c])); return api; },
      or(expr) { filtros.push(filtroOr(expr)); return api; },
      gte(c, v) { filtros.push((r) => String(r[c]) >= String(v)); return api; },
      lt(c, v) { filtros.push((r) => String(r[c]) < String(v)); return api; },
      order() { return api; },
      limit() { return api; },
      single() { unica = 'single'; return api; },
      maybeSingle() { unica = 'maybe'; return api; },
      then(res, rej) { return Promise.resolve().then(executar).then(res, rej); },
    };

    function hidratar(r) {
      const copia = { ...r };
      if (embed === 'empresas') {
        copia.empresas = (tabelas.empresas || []).find((e) => e.id === r.empresa_id) || null;
      }
      return copia;
    }

    function responder(linhas) {
      const l = linhas.map(hidratar);
      if (unica === 'single') {
        return l.length === 1 ? { data: l[0], error: null } : { data: null, error: { message: `single: ${l.length} linhas` } };
      }
      if (unica === 'maybe') {
        if (l.length > 1) return { data: null, error: { message: 'multiple rows' } };
        return { data: l[0] || null, error: null };
      }
      return { data: l, error: null };
    }

    function executar() {
      if (semTabela.includes(nome)) {
        return { data: null, error: { message: `Could not find the table 'public.${nome}' in the schema cache` } };
      }
      const t = tabelas[nome] || (tabelas[nome] = []);
      if (modo === 'insert' || (modo === 'upsert' && conflito)) {
        const novas = (Array.isArray(payload) ? payload : [payload]).map((p) => ({ id: `x${++seq}`, ...p }));
        if (modo === 'upsert') {
          for (const n of novas) {
            const i = t.findIndex((r) => r[conflito] === n[conflito]);
            if (i >= 0) { t[i] = { ...t[i], ...n, id: t[i].id }; continue; }
            t.push(n);
          }
          return responder(novas);
        }
        t.push(...novas);
        return responder(novas);
      }
      const alvo = t.filter((r) => filtros.every((f) => f(r)));
      if (modo === 'update') { alvo.forEach((r) => Object.assign(r, payload)); return responder(alvo); }
      if (modo === 'delete') { alvo.forEach((r) => t.splice(t.indexOf(r), 1)); return responder(alvo); }
      return responder(alvo);
    }
    return api;
  }
  return { tabelas, client: { from } };
}

// ── Monta as rotas reais sobre o banco falso ─────────────────────────────────
function carregarRotas(banco) {
  const raiz = path.join(__dirname, '..', 'src') + path.sep;
  const fixar = (rel, exports) => {
    const f = path.join(raiz, rel);
    require.cache[f] = { id: f, filename: f, loaded: true, exports };
  };
  for (const k of Object.keys(require.cache)) if (k.startsWith(raiz)) delete require.cache[k];

  fixar('db/supabase.js', banco.client);
  fixar('middlewares/auth.js', (req, res, next) => next());
  fixar('services/cripto.js', { encrypt: (x) => x, decrypt: (x) => x });
  fixar('services/hotmart-import.js', { importarHistoricoHotmart: async () => {} });
  fixar('handlers/insights-negocio.js', { gerarInsights: async () => [] });
  // O DRE de verdade não é o assunto deste eval; o que importa é QUEM chega nele.
  fixar('handlers/negocios.js', { gerarDre: async () => null, sugerirConciliacao: async () => [] });

  const router = require(path.join(raiz, 'routes/negocios.js'));
  const handler = (metodo, rota) => {
    const layer = router.stack.find((l) => l.route && l.route.path === rota && l.route.methods[metodo]);
    if (!layer) throw new Error(`rota não encontrada: ${metodo} ${rota}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
  };
  const chamar = (metodo, rota) => async (userId, req = {}) => {
    const res = {
      statusCode: 200, body: null,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
    await handler(metodo, rota)({ params: {}, query: {}, body: {}, authUser: { id: userId }, ...req }, res);
    return res;
  };
  return {
    listarEmpresas: chamar('get', '/empresas/:phone'),
    editarEmpresa:  chamar('put', '/empresas/:id'),
    arquivarEmpresa: chamar('delete', '/empresas/:id'),
    listarLanc:  chamar('get', '/lancamentos/:phone'),
    criarLanc:   chamar('post', '/lancamentos'),
    editarLanc:  chamar('put', '/lancamentos/:id'),
    apagarLanc:  chamar('delete', '/lancamentos/:id'),
    listarCustos: chamar('get', '/custos/:phone'),
    criarCusto:   chamar('post', '/custos'),
    apagarCusto:  chamar('delete', '/custos/:id'),
    apagarInteg:  chamar('delete', '/integracoes/:id'),
    criarInteg:   chamar('post', '/integracoes'),
    dispensarInsight: chamar('post', '/insights/:id/dispensar'),
    apagarConcil: chamar('delete', '/conciliacao/:id'),
  };
}

// ── Cenário: a rede de lojas do relato ───────────────────────────────────────
// DONA opera 2 lojas. GERENTE é operador SÓ da loja A. CONTADOR é leitura da A.
// ESTRANHA é outra cliente da Sora, sem nada a ver com essa rede.
const MES = new Date().toISOString().slice(0, 7);
const DIA = `${MES}-15`;

function cenario() {
  return {
    users: [
      { id: 'u-dona',     grupo_ativo: 'g1', plano: 'platinum' },
      { id: 'u-gerente',  grupo_ativo: 'g2', plano: 'platinum' },
      { id: 'u-contador', grupo_ativo: 'g3', plano: 'platinum' },
      { id: 'u-estranha', grupo_ativo: 'g9', plano: 'platinum' },
    ],
    empresas: [
      { id: 'e-a', user_id: 'u-dona',     grupo_id: 'g1', nome: 'Loja A', tipo: 'fisico', ativa: true },
      { id: 'e-b', user_id: 'u-dona',     grupo_id: 'g1', nome: 'Loja B', tipo: 'fisico', ativa: true },
      { id: 'e-z', user_id: 'u-estranha', grupo_id: 'g9', nome: 'Outra',  tipo: 'fisico', ativa: true },
    ],
    empresa_membros: [
      { id: 'm1', empresa_id: 'e-a', user_id: 'u-dona',     papel: 'admin',    padrao: false },
      { id: 'm2', empresa_id: 'e-b', user_id: 'u-dona',     papel: 'admin',    padrao: false },
      { id: 'm3', empresa_id: 'e-a', user_id: 'u-gerente',  papel: 'operador', padrao: true },
      { id: 'm4', empresa_id: 'e-a', user_id: 'u-contador', papel: 'leitura',  padrao: true },
    ],
    lancamentos_negocio: [
      { id: 'l-a1', empresa_id: 'e-a', user_id: 'u-dona', tipo: 'saida', descricao: 'Fornecedor', valor: 5000, data: DIA, status: 'pago' },
      { id: 'l-b1', empresa_id: 'e-b', user_id: 'u-dona', tipo: 'saida', descricao: 'Aluguel',    valor: 9000, data: DIA, status: 'pago' },
    ],
    custos_negocio: [
      { id: 'c-orf', empresa_id: null, user_id: 'u-dona', grupo_id: 'g1', data: DIA, valor: 2500, categoria: 'outros', descricao: 'Órfão' },
      { id: 'c-a',   empresa_id: 'e-a', user_id: 'u-dona', grupo_id: 'g1', data: DIA, valor: 100, categoria: 'outros', descricao: 'Da loja A' },
    ],
    integracoes: [
      { id: 'i-z', empresa_id: 'e-z', user_id: 'u-estranha', grupo_id: 'g9', plataforma: 'hotmart', status: 'ativa' },
    ],
    insights_negocio: [
      { id: 'in-z', empresa_id: 'e-z', user_id: 'u-estranha', dispensado: false },
    ],
    conciliacao_negocio: [
      { id: 'cc-z', user_id: 'u-estranha', evento_id: 'ev-z' },
    ],
    dre_snapshots: [
      { id: 's-a', empresa_id: 'e-a', user_id: 'u-dona', periodo: `${MES}-01` },
      { id: 's-b', empresa_id: 'e-b', user_id: 'u-dona', periodo: `${MES}-01` },
    ],
    eventos_financeiros: [],
    contas_negocio: [],
    funcionarios_negocio: [],
    config_negocio: [],
  };
}

const nomes = (r) => (r.body || []).map((e) => e.nome).sort().join(',');

(async () => {
  console.log('── 1. REGRESSÃO ZERO: sem a 173, o dono faz o que sempre fez ──');
  {
    // A tabela `empresa_membros` responde "não existe", como o PostgREST faria
    // com a migration pendente. NADA pode mudar pro dono.
    const b = criarBanco(cenario(), { semTabela: ['empresa_membros'] });
    const r = carregarRotas(b);

    eq(nomes(await r.listarEmpresas('u-dona')), 'Loja A,Loja B', 'dona lista as 2 empresas dela');
    eq((await r.listarLanc('u-dona', { query: { empresa_id: 'e-a' } })).statusCode, 200, 'lê o caixa da A');
    eq((await r.editarLanc('u-dona', { params: { id: 'l-a1' }, body: { valor: 5500 } })).statusCode, 200, 'edita o próprio lançamento');
    eq((await r.editarEmpresa('u-dona', { params: { id: 'e-a' }, body: { nome: 'Loja A2' } })).statusCode, 200, 'renomeia a própria empresa');
    eq((await r.arquivarEmpresa('u-dona', { params: { id: 'e-b' } })).statusCode, 200, 'arquiva a própria empresa');

    // E o estranho continua barrado mesmo sem a 173.
    eq((await r.editarLanc('u-estranha', { params: { id: 'l-a1' }, body: { valor: 1 } })).statusCode, 404,
      '⚠️ sem a 173 o estranho SEGUE barrado (a degradação nega, não libera)');
  }
  console.log('  ok');

  console.log('── 2. o membro convidado alcança a empresa ──');
  {
    const b = criarBanco(cenario());
    const r = carregarRotas(b);

    eq(nomes(await r.listarEmpresas('u-gerente')), 'Loja A', 'gerente vê SÓ a loja dele (não a rede inteira)');
    eq(nomes(await r.listarEmpresas('u-dona')), 'Loja A,Loja B', 'dona continua vendo as duas');

    const ed = await r.editarLanc('u-gerente', { params: { id: 'l-a1' }, body: { status: 'pago' } });
    eq(ed.statusCode, 200, '⚠️ gerente DÁ BAIXA no lançamento que a DONA criou (o bug que motivou a fase)');

    const novo = await r.criarLanc('u-gerente', { body: { empresa_id: 'e-a', tipo: 'entrada', descricao: 'Venda', valor: 3000, data: DIA } });
    eq(novo.statusCode, 200, 'gerente lança na loja dele');
    eq(novo.body.lancamento.user_id, 'u-gerente', 'a AUTORIA fica com quem lançou');
    eq(novo.body.lancamento.empresa_id, 'e-a', 'e o escopo com a empresa');

    // A fronteira: a loja B não é dele.
    eq((await r.editarLanc('u-gerente', { params: { id: 'l-b1' }, body: { valor: 1 } })).statusCode, 404,
      '⚠️ gerente da A NÃO alcança a loja B, embora as duas sejam da mesma dona');
    eq((await r.listarLanc('u-gerente', { query: { empresa_id: 'e-b' } })).statusCode, 404, 'nem o caixa da B');
  }
  console.log('  ok');

  console.log('── 3. o estranho não alcança nada, nem sabendo o id ──');
  {
    const b = criarBanco(cenario());
    const r = carregarRotas(b);

    eq(nomes(await r.listarEmpresas('u-estranha')), 'Outra', 'lista só a própria');
    eq((await r.editarLanc('u-estranha', { params: { id: 'l-a1' }, body: { valor: 1 } })).statusCode, 404, 'não edita lançamento alheio');
    eq((await r.apagarLanc('u-estranha', { params: { id: 'l-a1' } })).statusCode, 404, 'não apaga lançamento alheio');
    eq((await r.editarEmpresa('u-estranha', { params: { id: 'e-a' }, body: { nome: 'x' } })).statusCode, 404, 'não renomeia empresa alheia');
    eq(b.tabelas.lancamentos_negocio.find((l) => l.id === 'l-a1').valor, 5000, 'e nada foi escrito');
  }
  console.log('  ok');

  console.log('── 4. papéis: leitura lê, operador escreve, só o dono arquiva ──');
  {
    const b = criarBanco(cenario());
    const r = carregarRotas(b);

    // CONTADOR (leitura)
    eq(nomes(await r.listarEmpresas('u-contador')), 'Loja A', 'contador vê a empresa');
    eq((await r.editarLanc('u-contador', { params: { id: 'l-a1' }, body: { valor: 1 } })).statusCode, 404,
      '⚠️ leitura NÃO escreve — o contador vê o DRE e não mexe no caixa');
    eq((await r.criarLanc('u-contador', { body: { empresa_id: 'e-a', tipo: 'saida', descricao: 'x', valor: 10, data: DIA } })).statusCode, 404,
      'leitura não lança');

    // GERENTE (operador) escreve, mas não mexe na empresa em si.
    eq((await r.editarEmpresa('u-gerente', { params: { id: 'e-a' }, body: { nome: 'Renomeada' } })).statusCode, 404,
      '⚠️ operador NÃO renomeia a empresa (isso é admin)');

    // Arquivar é só do DONO — nem o admin convidado.
    const bb = criarBanco(cenario());
    bb.tabelas.empresa_membros.push({ id: 'm5', empresa_id: 'e-a', user_id: 'u-gerente2', papel: 'admin', padrao: false });
    bb.tabelas.users.push({ id: 'u-gerente2', grupo_ativo: 'g4', plano: 'platinum' });
    const rr = carregarRotas(bb);
    eq((await rr.editarEmpresa('u-gerente2', { params: { id: 'e-a' }, body: { nome: 'Pode' } })).statusCode, 200,
      'admin convidado RENOMEIA');
    eq((await rr.arquivarEmpresa('u-gerente2', { params: { id: 'e-a' } })).statusCode, 404,
      '⚠️ mas NÃO arquiva: some com o histórico da equipe inteira e não tem desfazer');
    eq(bb.tabelas.empresas.find((e) => e.id === 'e-a').ativa, true, 'a empresa continua de pé');
    eq((await rr.arquivarEmpresa('u-dona', { params: { id: 'e-a' } })).statusCode, 200, 'o dono arquiva');
  }
  console.log('  ok');

  console.log('── 5. as rotas que não conferiam dono NENHUM ──');
  {
    const b = criarBanco(cenario());
    const r = carregarRotas(b);

    // Todas estas respondiam 200 pra QUALQUER conta logada que soubesse o id.
    eq((await r.apagarInteg('u-dona', { params: { id: 'i-z' } })).statusCode, 404, '⚠️ DELETE /integracoes/:id não apaga a de outra conta');
    eq(b.tabelas.integracoes.length, 1, 'a integração da estranha continua lá');

    // ⚠️ O NEGATIVO AQUI É O ÓRFÃO, não o custo da loja: `c-a` é da Loja A e
    // o gerente é operador dela, então apagá-lo é o comportamento CERTO. Já
    // `c-orf` não tem empresa — ninguém sabe de qual loja é, e o alcance cai
    // na regra antiga (só o próprio dono).
    eq((await r.apagarCusto('u-gerente', { params: { id: 'c-orf' } })).statusCode, 404,
      '⚠️ DELETE /custos/:id: o gerente não apaga o custo ÓRFÃO do dono');
    eq(b.tabelas.custos_negocio.some((c) => c.id === 'c-orf'), true, 'o órfão continua lá');
    eq((await r.dispensarInsight('u-dona', { params: { id: 'in-z' } })).statusCode, 404, '⚠️ insight de outra conta não é dispensado');
    eq(b.tabelas.insights_negocio[0].dispensado, false, 'e segue não dispensado');

    eq((await r.apagarConcil('u-dona', { params: { id: 'cc-z' } })).statusCode, 404, '⚠️ conciliação de outra conta não é apagada');
    eq(b.tabelas.conciliacao_negocio.length, 1, 'e segue lá');

    // O positivo: o dono legítimo continua conseguindo.
    eq((await r.apagarCusto('u-dona', { params: { id: 'c-a' } })).statusCode, 200, 'o dono apaga o custo dele');
  }
  console.log('  ok');

  console.log('── 6. custo órfão (empresa_id null) continua visível pro dono ──');
  {
    const b = criarBanco(cenario());
    const r = carregarRotas(b);

    const lista = await r.listarCustos('u-dona', { query: { empresa_id: 'e-a' } });
    const ids = (lista.body || []).map((c) => c.id).sort();
    eq(ids.join(','), 'c-a,c-orf',
      '⚠️ a LEITURA degrada pro lado de MOSTRAR: o custo sem empresa não some da tela de quem o lançou');

    // E o órfão do dono NÃO vaza pro membro — ninguém sabe de qual loja ele é.
    const doGerente = await r.listarCustos('u-gerente', { query: { empresa_id: 'e-a' } });
    eq((doGerente.body || []).map((c) => c.id).join(','), 'c-a', '⚠️ o órfão não vaza pro membro convidado');
  }
  console.log('  ok');

  console.log('── 7. insert grava empresa_id (era o que criava os órfãos) ──');
  {
    const b = criarBanco(cenario());
    const r = carregarRotas(b);

    const c = await r.criarCusto('u-dona', { body: { empresa_id: 'e-a', categoria: 'outros', descricao: 'Novo', valor: 50, data: DIA } });
    eq(c.statusCode, 200, 'custo criado');
    eq(c.body.custo.empresa_id, 'e-a', '⚠️ o POST de custo NUNCA gravava empresa_id — é a origem dos 3 órfãos da base');

    const i = await r.criarInteg('u-dona', { body: { empresa_id: 'e-a', plataforma: 'hotmart', credenciais: {} } });
    eq(i.statusCode, 200, 'integração criada');
    eq(b.tabelas.integracoes.find((x) => x.plataforma === 'hotmart' && x.user_id === 'u-dona').empresa_id, 'e-a',
      'integração nasce com empresa');
  }
  console.log('  ok');

  console.log('── 8. invalidar snapshot do DRE é por EMPRESA ──');
  {
    const b = criarBanco(cenario());
    const r = carregarRotas(b);

    await r.criarCusto('u-dona', { body: { empresa_id: 'e-a', categoria: 'outros', descricao: 'X', valor: 50, data: DIA } });
    const vivos = b.tabelas.dre_snapshots.map((s) => s.id).sort().join(',');
    eq(vivos, 's-b', '⚠️ derruba SÓ o snapshot da loja A — por user_id derrubaria o da B junto');
  }
  console.log('  ok');

  console.log('');
  if (falhas.length) {
    console.error(`✗ ${falhas.length} falha(s):`);
    falhas.forEach((f) => console.error('  ·', f));
    process.exit(1);
  }
  console.log('✓ acesso às rotas de Negócios: todos os casos passaram');
})();
