// =============================================================================
// EVAL DE ROTA — categorias PRÓPRIAS do Sora Negócios (migration 196).
//
// O que não pode acontecer:
//   - renomear a categoria e deixar os lançamentos no nome antigo (histórico
//     numa categoria que não existe mais — a família da conta-fantasma);
//   - mexer em lançamento de OUTRA empresa ou de OUTRO tipo;
//   - juntar duas categorias sem a pessoa confirmar;
//   - quem só lança (operador) renomear ou apagar a categoria de todo mundo;
//   - falhar no meio e deixar a categoria renomeada com o histórico no nome velho;
//   - mostrar "migration" pro cliente.
//
// Rodar: npm run eval:categorias-negocio-rota
// =============================================================================
const path = require('path');

const falhas = [];
let total = 0;
const ok = (c, m) => { total++; if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}\n     esperado ${JSON.stringify(b)}\n     veio     ${JSON.stringify(a)}`);

function criarBanco(inicial, { semTabela = false, falharUpdateLanc = false, falharLeituraLanc = false } = {}) {
  const tabelas = JSON.parse(JSON.stringify(inicial));
  const escritas = {};
  let seq = 0;
  function from(nome) {
    const filtros = [];
    let modo = 'select', payload = null, unica = false, faixa = null;
    const api = {
      select() { return api; }, order() { return api; },
      update(p) { modo = 'update'; payload = p; return api; },
      insert(p) { modo = 'insert'; payload = p; return api; },
      delete() { modo = 'delete'; return api; },
      eq(c, v) { filtros.push((r) => r[c] === v); return api; },
      in(c, vs) { filtros.push((r) => vs.includes(r[c])); return api; },
      not(c, op, v) { if (op === 'is' && v === null) filtros.push((r) => r[c] != null); return api; },
      range(a, b) { faixa = [a, b]; return api; },
      maybeSingle() { unica = true; return api; },
      then(res, rej) { return Promise.resolve().then(exec).then(res, rej); },
    };
    function exec() {
      if (semTabela && nome === 'categorias_negocio') {
        return { data: null, error: { message: 'relation "public.categorias_negocio" does not exist' } };
      }
      if (falharLeituraLanc && nome === 'lancamentos_negocio' && modo === 'select') {
        return { data: null, error: { message: 'falha de rede' } };
      }
      if (falharUpdateLanc && nome === 'lancamentos_negocio' && modo === 'update') {
        return { data: null, error: { message: 'falha no update' } };
      }
      if (modo !== 'select') escritas[nome] = (escritas[nome] || 0) + 1;
      const t = tabelas[nome] || (tabelas[nome] = []);
      if (modo === 'insert') {
        const linha = { id: `n${++seq}`, oculta: false, icone: null, natureza: null, ...payload };
        if (nome === 'categorias_negocio') {
          const k = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
          if (t.some((r) => r.empresa_id === linha.empresa_id && r.tipo === linha.tipo && k(r.nome) === k(linha.nome))) {
            return { data: null, error: { code: '23505', message: 'duplicate key' } };
          }
        }
        t.push(linha);
        return { data: unica ? { ...linha } : [{ ...linha }], error: null };
      }
      let alvo = t.filter((r) => filtros.every((f) => f(r)));
      if (faixa) alvo = alvo.slice(faixa[0], faixa[1] + 1);
      if (modo === 'update') alvo.forEach((r) => Object.assign(r, payload));
      if (modo === 'delete') tabelas[nome] = t.filter((r) => !alvo.includes(r));
      const l = alvo.map((r) => ({ ...r }));
      return unica ? { data: l[0] || null, error: null } : { data: l, error: null };
    }
    return api;
  }
  return { tabelas, escritas, client: { from } };
}

// u1 = admin da e1 · u2 = operador da e1 · ninguém alcança e2 a não ser u9.
const PAPEL = { 'u1|e1': 'admin', 'u2|e1': 'operador', 'u9|e2': 'admin' };
const NIVEL = ['leitura', 'operador', 'admin'];

function carregar(banco) {
  const raiz = path.join(__dirname, '..', 'src') + path.sep;
  const fixar = (rel, ex) => { const f = path.join(raiz, rel); require.cache[f] = { id: f, filename: f, loaded: true, exports: ex }; };
  for (const k of Object.keys(require.cache)) if (k.startsWith(raiz)) delete require.cache[k];
  fixar('db/supabase.js', banco.client);
  fixar('middlewares/auth.js', (q, s, n) => n());
  fixar('config/planos.js', { temNegocios: () => true });
  fixar('handlers/negocios.js', { gerarDre: async () => ({}), sugerirConciliacao: async () => [] });
  fixar('handlers/insights-negocio.js', { gerarInsights: async () => [] });
  fixar('services/cripto.js', { encrypt: (x) => x, decrypt: (x) => x });
  fixar('services/hotmart-import.js', { importarHistoricoHotmart: async () => ({}) });
  fixar('services/acessoEmpresa.js', {
    podeNaEmpresa: async (u, e, min = 'operador') => {
      const p = PAPEL[`${u}|${e}`];
      return !!p && NIVEL.indexOf(p) >= NIVEL.indexOf(min);
    },
    empresasDoUsuario: async (u) => Object.keys(PAPEL).filter((k) => k.startsWith(`${u}|`)).map((k) => ({ id: k.split('|')[1], papel: PAPEL[k] })),
    empresaAssumida: () => null, papelPermite: () => true, papelNaEmpresa: async () => 'admin', PAPEIS: NIVEL,
  });
  const router = require(path.join(raiz, 'routes/negocios.js'));
  const h = (m, r) => { const l = router.stack.find((x) => x.route && x.route.path === r && x.route.methods[m]); return l.route.stack[l.route.stack.length - 1].handle; };
  const chamar = (m, r) => async (req = {}, user = 'u1') => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await h(m, r)({ params: { phone: 'p' }, query: {}, body: {}, authUser: { id: user }, ...req }, res);
    return res;
  };
  return {
    listar: chamar('get', '/categorias/:phone'),
    salvar: chamar('post', '/categorias'),
    renomear: chamar('post', '/categorias/renomear'),
    remover: chamar('post', '/categorias/remover'),
  };
}

const L = (id, empresa_id, tipo, categoria) => ({ id, empresa_id, tipo, categoria, descricao: id });
const cenario = () => ({
  users: [{ id: 'u1', grupo_ativo: 'g1' }, { id: 'u2', grupo_ativo: 'g1' }, { id: 'u9', grupo_ativo: 'g9' }],
  categorias_negocio: [
    { id: 'c1', empresa_id: 'e1', tipo: 'saida', nome: 'Conveniência', icone: 'Store', natureza: 'fixa', oculta: false },
    { id: 'c9', empresa_id: 'e2', tipo: 'saida', nome: 'Conveniência', icone: 'Coffee', natureza: null, oculta: false },
  ],
  lancamentos_negocio: [
    L('l1', 'e1', 'saida', 'CONVENIENCIA'), L('l2', 'e1', 'saida', 'Conveniencia'),
    L('l3', 'e1', 'saida', 'COVENIENCIA'), L('l4', 'e1', 'saida', 'Sistema de Controle'),
    L('l5', 'e1', 'saida', 'Sistema de Controle'), L('l6', 'e1', 'saida', 'aluguel'),
    L('l7', 'e1', 'entrada', 'Sistema de Controle'),   // mesmo nome, OUTRO tipo
    L('l8', 'e2', 'saida', 'Sistema de Controle'),     // mesmo nome, OUTRA empresa
    L('l9', 'e1', 'saida', null),
  ],
  regras_negocio: [
    { id: 'r1', empresa_id: 'e1', termo: 'dom', tipo: 'saida', categoria: 'Sistema de Controle' },
    { id: 'r2', empresa_id: 'e1', termo: 'x', tipo: null, categoria: 'sistema de controle' },
    { id: 'r3', empresa_id: 'e1', termo: 'y', tipo: 'entrada', categoria: 'Sistema de Controle' },
    { id: 'r4', empresa_id: 'e2', termo: 'z', tipo: 'saida', categoria: 'Sistema de Controle' },
  ],
});
const cat = (b, id) => b.tabelas.lancamentos_negocio.find((l) => l.id === id).categoria;
const regra = (b, id) => b.tabelas.regras_negocio.find((r) => r.id === id).categoria;
const linhas = (b, emp = 'e1') => b.tabelas.categorias_negocio.filter((c) => c.empresa_id === emp);
const semJargao = (t) => !/migra|tabela|supabase|sql/i.test(String(t || ''));

(async () => {
  console.log('§1 listar');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    const x = await r.listar({ query: { empresa_id: 'e1' } });
    eq(x.statusCode, 200, '§1 200');
    eq(x.body.categorias.map((c) => `${c.tipo}:${c.nome}:${c.usos}:${c.icone}`),
      ['entrada:Sistema de Controle:1:null', 'saida:Conveniência:2:Store', 'saida:COVENIENCIA:1:null', 'saida:Sistema de Controle:2:null'],
      '§1 guardadas + digitadas, só da empresa pedida, fixas fora');
    eq(x.body.semMigration, false, '§1 com a tabela');
    const sem = await carregar(criarBanco(cenario(), { semTabela: true })).listar({ query: { empresa_id: 'e1' } });
    eq([sem.statusCode, sem.body.semMigration, sem.body.categorias.length], [200, true, 4],
      '§1 sem a 196: as digitadas aparecem mesmo assim (só sem ícone)');
    const falha = await carregar(criarBanco(cenario(), { falharLeituraLanc: true })).listar({ query: { empresa_id: 'e1' } });
    eq(falha.statusCode, 500, '§1 falha de leitura é erro, nunca lista vazia');
  }

  console.log('§2 criar');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    const x = await r.salvar({ body: { empresa_id: 'e1', tipo: 'saida', nome: '  sistema de CONTROLE ', icone: 'Laptop', natureza: 'fixa' } });
    eq([x.statusCode, x.body.criada, x.body.categoria.nome, x.body.categoria.icone], [200, true, 'sistema de CONTROLE', 'Laptop'], '§2 cria com o nome digitado');
    eq([cat(b, 'l4'), cat(b, 'l5')], ['sistema de CONTROLE', 'sistema de CONTROLE'], '§2 grafias antigas da mesma categoria passam pro nome guardado');
    eq(cat(b, 'l7'), 'Sistema de Controle', '§2 OUTRO tipo não é tocado');
    eq(cat(b, 'l8'), 'Sistema de Controle', '§2 OUTRA empresa não é tocada');
    eq(regra(b, 'r1'), 'sistema de CONTROLE', '§2 regra do mesmo tipo acompanha');
    eq(regra(b, 'r4'), 'Sistema de Controle', '§2 regra de outra empresa não');

    const de = await r.salvar({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'CONVENIÊNCIA', icone: 'Coffee' } });
    eq([de.body.criada, linhas(b).filter((c) => c.tipo === 'saida' && /conven/i.test(c.nome)).length], [false, 1], '§2 mesmo nome sem acento/caixa ATUALIZA, não duplica');
    eq([linhas(b).find((c) => c.id === 'c1').icone, linhas(b).find((c) => c.id === 'c1').natureza], ['Coffee', 'fixa'],
      '§2 só o campo enviado muda (natureza ficou)');

    eq((await r.salvar({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'Aluguel' } })).statusCode, 400, '§2 colide com padrão → 400');
    eq((await r.salvar({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'Padaria', icone: 'Skull' } })).statusCode, 400, '§2 ícone fora da lista → 400');
    eq((await r.salvar({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'Padaria', natureza: 'mensal' } })).statusCode, 400, '§2 natureza inválida → 400');
    eq((await r.salvar({ body: { empresa_id: 'e2', tipo: 'saida', nome: 'Padaria' } })).statusCode, 404, '§2 empresa que a pessoa não alcança → 404');
    const op = await r.salvar({ body: { empresa_id: 'e1', tipo: 'entrada', nome: 'Gorjetas', icone: 'HandCoins', natureza: 'fixa' } }, 'u2');
    eq([op.statusCode, op.body.categoria.natureza], [200, null], '§2 operador cria; entrada não guarda natureza');

    const b3 = criarBanco(cenario());
    await carregar(b3).salvar({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'Sistema de Controle' } });
    eq(b3.escritas.lancamentos_negocio || 0, 0, '§2 grafia já igual: NENHUMA escrita nos lançamentos (egress)');

    const sem = criarBanco(cenario(), { semTabela: true });
    const s = await carregar(sem).salvar({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'Padaria' } });
    eq([s.statusCode, s.body.semMigration], [503, true], '§2 sem a 196 → 503');
    ok(semJargao(s.body.erro), `§2 o aviso não fala de migration/tabela pro cliente: "${s.body.erro}"`);
  }

  console.log('§3 renomear');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    const x = await r.renomear({ body: { empresa_id: 'e1', tipo: 'saida', de: 'Sistema de Controle', para: 'Software' } });
    eq([x.statusCode, x.body.nome, x.body.lancamentos], [200, 'Software', 2], '§3 renomeia e leva os 2 lançamentos');
    eq([cat(b, 'l4'), cat(b, 'l5'), cat(b, 'l7'), cat(b, 'l8')], ['Software', 'Software', 'Sistema de Controle', 'Sistema de Controle'],
      '§3 só do mesmo tipo e da mesma empresa');
    eq([regra(b, 'r1'), regra(b, 'r2'), regra(b, 'r3'), regra(b, 'r4')], ['Software', 'Software', 'Sistema de Controle', 'Sistema de Controle'],
      '§3 regras: do tipo e sem tipo acompanham; de entrada e de outra empresa não');

    const g = await r.renomear({ body: { empresa_id: 'e1', tipo: 'saida', de: 'Conveniência', para: 'Loja de conveniência' } });
    eq([g.statusCode, cat(b, 'l1'), cat(b, 'l2'), linhas(b).find((c) => c.id === 'c1').nome],
      [200, 'Loja de conveniência', 'Loja de conveniência', 'Loja de conveniência'],
      '§3 guardada: a linha E todas as grafias dos lançamentos mudam');
    eq(b.tabelas.categorias_negocio.find((c) => c.id === 'c9').nome, 'Conveniência', '§3 a de outra empresa não muda');

    eq((await r.renomear({ body: { empresa_id: 'e1', tipo: 'saida', de: 'aluguel', para: 'Aluguel loja' } })).statusCode, 400, '§3 padrão não se renomeia');
    eq((await r.renomear({ body: { empresa_id: 'e1', tipo: 'saida', de: 'Inexistente', para: 'X' } })).statusCode, 404, '§3 inexistente → 404');
    eq((await r.renomear({ body: { empresa_id: 'e1', tipo: 'saida', de: 'COVENIENCIA', para: 'Conveniência 2' } }, 'u2')).statusCode, 404,
      '§3 operador NÃO renomeia (mexe no histórico de todos)');
  }

  console.log('§4 juntar');
  {
    const b = criarBanco(cenario()); const r = carregar(b);
    const sem = await r.renomear({ body: { empresa_id: 'e1', tipo: 'saida', de: 'COVENIENCIA', para: 'conveniencia' } });
    eq([sem.statusCode, sem.body.existente], [409, 'Conveniência'], '§4 nome de outra categoria → 409 e diz qual');
    eq(cat(b, 'l3'), 'COVENIENCIA', '§4 sem confirmar, nada muda');
    const com = await r.renomear({ body: { empresa_id: 'e1', tipo: 'saida', de: 'COVENIENCIA', para: 'conveniencia', juntar: true } });
    eq([com.statusCode, com.body.nome, com.body.juntou, cat(b, 'l3')], [200, 'Conveniência', true, 'Conveniência'],
      '§4 junta no nome da que já existia');
    eq(linhas(b).filter((c) => c.tipo === 'saida').length, 1, '§4 continua uma categoria guardada só');

    // Juntar duas GUARDADAS: a de origem deixa de existir.
    const b2 = criarBanco({ ...cenario(), categorias_negocio: [...cenario().categorias_negocio,
      { id: 'c2', empresa_id: 'e1', tipo: 'saida', nome: 'COVENIENCIA', icone: 'Tag', natureza: null, oculta: false }] });
    const j2 = await carregar(b2).renomear({ body: { empresa_id: 'e1', tipo: 'saida', de: 'COVENIENCIA', para: 'Conveniência', juntar: true } });
    eq([j2.statusCode, linhas(b2).map((c) => c.id), cat(b2, 'l3')], [200, ['c1'], 'Conveniência'], '§4 duas guardadas → fica a de destino');
  }

  console.log('§5 falha no meio');
  {
    const b = criarBanco(cenario(), { falharUpdateLanc: true }); const r = carregar(b);
    const x = await r.renomear({ body: { empresa_id: 'e1', tipo: 'saida', de: 'Conveniência', para: 'Mercadinho' } });
    eq(x.statusCode, 500, '§5 falha na cascata → erro');
    eq(linhas(b).find((c) => c.id === 'c1').nome, 'Conveniência', '§5 o nome da categoria VOLTA (não fica renomeada com o histórico no velho)');
  }

  console.log('§6 sem a migration, renomear ainda funciona');
  {
    const b = criarBanco(cenario(), { semTabela: true }); const r = carregar(b);
    const x = await r.renomear({ body: { empresa_id: 'e1', tipo: 'saida', de: 'COVENIENCIA', para: 'Conveniência', juntar: true } });
    eq([x.statusCode, cat(b, 'l3'), cat(b, 'l1')], [200, 'Conveniencia', 'CONVENIENCIA'], '§6 só os lançamentos mudam (no nome da que já existia)');
  }

  console.log('§7 remover');
  {
    const b = criarBanco({ ...cenario(), categorias_negocio: [...cenario().categorias_negocio,
      { id: 'c3', empresa_id: 'e1', tipo: 'saida', nome: 'Sem uso', icone: null, natureza: null, oculta: false }] });
    const r = carregar(b);
    const vazio = await r.remover({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'Sem uso' } });
    eq([vazio.statusCode, vazio.body.removida, linhas(b).some((c) => c.id === 'c3')], [200, true, false], '§7 sem lançamento: só apaga');

    const pergunta = await r.remover({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'Sistema de Controle' } });
    eq([pergunta.statusCode, pergunta.body.usos, cat(b, 'l4')], [409, 2, 'Sistema de Controle'], '§7 com lançamento e sem escolha: pergunta, não mexe');

    const fixa = await r.remover({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'Sistema de Controle', acao: 'mover', para: 'Luz / Água' } });
    eq([fixa.statusCode, fixa.body.para, cat(b, 'l4'), cat(b, 'l5'), cat(b, 'l7')], [200, 'energia', 'energia', 'energia', 'Sistema de Controle'],
      '§7 mover pra padrão grava o VALOR padrão ("energia"), só no mesmo tipo');

    const propria = await r.remover({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'COVENIENCIA', acao: 'mover', para: 'conveniência' } });
    eq([propria.statusCode, cat(b, 'l3')], [200, 'Conveniência'], '§7 mover pra outra própria usa o nome dela');

    eq((await r.remover({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'Conveniência', acao: 'mover', para: 'Conveniência' } })).statusCode, 400,
      '§7 mover pra ela mesma → 400');
    eq((await r.remover({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'Conveniência', acao: 'mover', para: 'a_classificar' } })).statusCode, 400,
      '§7 marca do sistema não é destino');

    const oc = await r.remover({ body: { empresa_id: 'e1', tipo: 'entrada', nome: 'Sistema de Controle', acao: 'ocultar' } });
    const nova = linhas(b).find((c) => c.tipo === 'entrada');
    eq([oc.statusCode, nova && nova.oculta, cat(b, 'l7')], [200, true, 'Sistema de Controle'], '§7 ocultar: sai da lista, lançamento intacto');
    const volta = await r.salvar({ body: { empresa_id: 'e1', tipo: 'entrada', nome: 'sistema de controle' } });
    eq([volta.body.criada, linhas(b).find((c) => c.tipo === 'entrada').oculta], [false, false], '§7 salvar de novo devolve à lista');

    eq((await r.remover({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'Conveniência', acao: 'ocultar' } }, 'u2')).statusCode, 404,
      '§7 operador não remove');
    eq((await r.remover({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'Fornecedor', acao: 'ocultar' } })).statusCode, 400, '§7 padrão não se remove');
    const sem = await carregar(criarBanco(cenario(), { semTabela: true })).remover({ body: { empresa_id: 'e1', tipo: 'saida', nome: 'COVENIENCIA', acao: 'ocultar' } });
    ok(sem.statusCode === 503 && semJargao(sem.body.erro), '§7 ocultar sem a 196 → 503 sem jargão');
  }

  console.log(`\n${total - falhas.length}/${total} ok`);
  if (falhas.length) { console.log('\nFALHAS:\n - ' + falhas.join('\n - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
