// =============================================================================
// EVAL — categoria da dívida (migration 198, nov/2026).
//
// Pedido de cliente: o Seguro Residencial parcelado entrava como "Dívidas" nos
// relatórios. A dívida ganhou categoria opcional e o pagamento da parcela é
// lançado nela.
//
// O que não pode acontecer:
//   · pagamento de dívida SEM categoria mudar de categoria (todo mundo hoje);
//   · gravar categoria que não existe no grupo (categoria-fantasma) ou de receita;
//   · a migration pendente quebrar criar/editar dívida — ou levar a FOTO junto;
//   · aceitar dívida de OUTRO grupo em quitar/lembrete.
//
// Roda as rotas REAIS sobre um banco falso. Rodar: npm run eval:categoria-divida
// =============================================================================
const Module = require('module');
const path = require('path');
const RAIZ = path.resolve(__dirname, '..');
process.env.SUPABASE_URL = 'http://falso';
process.env.SUPABASE_KEY = 'falso';

const svc = require('../src/services/categoriaDivida');

const falhas = [];
let casos = 0;
const ok = (c, m) => { casos++; if (!c) falhas.push(m); };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)})`);

const ERRO_COLUNA = { message: "Could not find the 'categoria' column of 'dividas' in the schema cache" };

function bancoFalso(tabelas, cfg = {}) {
  let seq = 0;
  const copia = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const log = { inserts: [], updates: [] };
  const from = (nome) => {
    const filtros = [];
    let modo = 'select', patch = null, novo = null;
    const casa = (r) => filtros.every(([op, c, v]) => (op === 'eq' ? r[c] === v : op === 'in' ? v.includes(r[c]) : true));
    const linhas = () => (tabelas[nome] = tabelas[nome] || []).filter(casa);
    const executar = () => {
      if (cfg.erroLeitura === nome && modo === 'select') return { data: null, error: { message: 'rede caiu' } };
      if (modo === 'insert') {
        if (cfg.semColuna && nome === 'dividas' && 'categoria' in novo) return { data: null, error: ERRO_COLUNA };
        const linha = { id: `${nome}-${++seq}`, ...novo };
        tabelas[nome].push(linha); log.inserts.push({ tabela: nome, obj: copia(novo) });
        return { data: linha, error: null };
      }
      if (modo === 'update') {
        if (cfg.semColuna && nome === 'dividas' && 'categoria' in patch) return { data: null, error: ERRO_COLUNA };
        const alvo = linhas();
        alvo.forEach((r) => Object.assign(r, patch));
        log.updates.push({ tabela: nome, patch: copia(patch), n: alvo.length });
        return { data: alvo[0] || null, error: alvo.length ? null : { message: 'JSON object requested, multiple (or no) rows returned' }, todas: alvo };
      }
      return { data: linhas()[0] || null, error: null, todas: linhas() };
    };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; }, not() { return q; }, gte() { return q; }, lte() { return q; },
      eq(c, v) { filtros.push(['eq', c, v]); return q; },
      in(c, v) { filtros.push(['in', c, v]); return q; },
      insert(o) { modo = 'insert'; novo = o; tabelas[nome] = tabelas[nome] || []; return q; },
      update(p) { modo = 'update'; patch = p; return q; },
      maybeSingle() { const r = executar(); return Promise.resolve({ data: copia(r.data), error: modo === 'select' ? r.error : r.error }); },
      single() { const r = executar(); return Promise.resolve({ data: copia(r.data), error: r.error }); },
      then(res, rej) { try { const r = executar(); return Promise.resolve(res({ data: copia(r.todas || r.data), error: r.error })); } catch (e) { return rej ? rej(e) : Promise.reject(e); } },
    };
    return q;
  };
  return { db: { from }, log };
}

const CATS = () => [
  { grupo_id: 'g1', nome: 'Seguros', tipo: 'despesa', ativa: true },
  { grupo_id: 'g1', nome: '🛡️ Seguro do veículo', tipo: 'despesa', ativa: true },
  { grupo_id: 'g1', nome: 'Presente', tipo: 'ambos', ativa: true },
  { grupo_id: 'g1', nome: 'Salário', tipo: 'receita', ativa: true },
  { grupo_id: 'g1', nome: 'Antiga', tipo: 'despesa', ativa: false },
  { grupo_id: 'g2', nome: 'Viagem', tipo: 'despesa', ativa: true },
];
const DIV = (extra = {}) => ({ id: 'd1', grupo_id: 'g1', titulo: 'Seguro Residencial Bradesco', tipo: 'parcelamento',
  valor_total: 91.89, valor_parcela: 30.63, parcelas_total: 3, parcelas_pagas: 1, dia_vencimento: 20,
  status: 'ativa', of_id: null, imagem_url: 'data:image/jpeg;base64,FOTO', ...extra });

async function rota({ caminho, metodo = 'post', params = {}, corpo = {}, tabelas, cfg }) {
  const t = { categorias: CATS(), dividas: [DIV()], divida_pagamentos: [], transacoes: [], ...tabelas };
  const { db, log } = bancoFalso(t, cfg);
  const debitos = [];
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req.endsWith('db/supabase')) return db;
    if (req.endsWith('services/contaDebito')) return { debitarConta: async (a) => { debitos.push(a); return { ok: true }; } };
    if (req.endsWith('middlewares/auth')) return (rq, rs, nx) => nx();
    if (req.endsWith('middlewares/permissao')) return { exigirPermissao: () => (rq, rs, nx) => nx() };
    return origLoad.call(this, req, parent, isMain);
  };
  for (const k of Object.keys(require.cache)) if (k.includes(path.join('sora-backend', 'src'))) delete require.cache[k];
  const router = require(path.join(RAIZ, 'src/routes/dividas.js'));
  Module._load = origLoad;
  const camada = router.stack.find((c) => c.route?.path === caminho && c.route?.methods?.[metodo]);
  const h = camada.route.stack[camada.route.stack.length - 1].handle;
  let status = 200, json = null;
  const res = { status(s) { status = s; return res; }, json(j) { json = j; return res; } };
  await h({ params, body: corpo, grupoId: 'g1', userId: 'u1', authUser: { id: 'u1' } }, res);
  return { status, json, log, debitos, t };
}

(async () => {
  // ── §1. Regra da categoria (serviço) ──────────────────────────────────────
  const { db: dbCat } = bancoFalso({ categorias: CATS() });
  eq(await svc.resolverCategoriaDivida(dbCat, 'g1', 'Seguros'), { ok: true, categoria: 'Seguros' }, '§1 nome exato');
  eq((await svc.resolverCategoriaDivida(dbCat, 'g1', '  seguros ')).categoria, 'Seguros', '§1 caixa e espaço → grafia oficial');
  eq((await svc.resolverCategoriaDivida(dbCat, 'g1', 'Seguro do veiculo')).categoria, '🛡️ Seguro do veículo', '§1 sem acento/emoji → nome oficial (com o emoji da lista)');
  eq((await svc.resolverCategoriaDivida(dbCat, 'g1', 'Presente')).categoria, 'Presente', '§1 categoria "ambos" vale');
  eq((await svc.resolverCategoriaDivida(dbCat, 'g1', 'Salário')).status, 400, '§1 categoria de RECEITA é recusada');
  eq((await svc.resolverCategoriaDivida(dbCat, 'g1', 'Antiga')).status, 400, '§1 categoria apagada é recusada');
  eq((await svc.resolverCategoriaDivida(dbCat, 'g1', 'Viagem')).status, 400, '§1 categoria de OUTRO grupo é recusada');
  eq((await svc.resolverCategoriaDivida(dbCat, 'g1', 'Inventada')).motivo, 'categoria_inexistente', '§1 nome que não existe não vira categoria');
  eq(await svc.resolverCategoriaDivida(dbCat, 'g1', ''), { ok: true, categoria: null }, '§1 vazio volta ao padrão');
  eq(await svc.resolverCategoriaDivida(dbCat, 'g1', null), { ok: true, categoria: null }, '§1 null volta ao padrão');
  eq((await svc.resolverCategoriaDivida(dbCat, 'g1', 123)).status, 400, '§1 não-texto é recusado');
  eq((await svc.resolverCategoriaDivida(dbCat, 'g1', 'x'.repeat(81))).status, 400, '§1 texto gigante é recusado');
  const { db: dbFalha } = bancoFalso({ categorias: CATS() }, { erroLeitura: 'categorias' });
  eq((await svc.resolverCategoriaDivida(dbFalha, 'g1', 'Seguros')).status, 500, '§1 leitura que falha NÃO vira "categoria inválida"');
  eq(svc.categoriaDoPagamento({ categoria: 'Seguros' }), 'Seguros', '§1 pagamento usa a categoria da dívida');
  eq(svc.categoriaDoPagamento({ categoria: null }), 'Dívidas', '§1 sem categoria: "Dívidas" (como sempre)');
  eq(svc.categoriaDoPagamento({}), 'Dívidas', '§1 dívida antiga sem a coluna: "Dívidas"');
  eq(svc.categoriaDoPagamento({ categoria: '   ' }), 'Dívidas', '§1 categoria em branco: "Dívidas"');
  const { db: dbDiv } = bancoFalso({ dividas: [DIV({ categoria: 'Seguros' }), DIV({ id: 'd2' })] });
  eq(await svc.lerCategoriaDivida(dbDiv, 'd1'), 'Seguros', '§1 leitura à parte (WhatsApp) acha a categoria');
  eq(await svc.lerCategoriaDivida(dbDiv, 'd2'), null, '§1 dívida sem categoria → null');
  const { db: dbDivFalha } = bancoFalso({ dividas: [DIV({ categoria: 'Seguros' })] }, { erroLeitura: 'dividas' });
  eq(await svc.lerCategoriaDivida(dbDivFalha, 'd1'), null, '§1 leitura à parte que falha → null ("Dívidas"), nunca quebra');

  // ── §2. Criar dívida ──────────────────────────────────────────────────────
  const novo = { titulo: 'Seguro Residencial', valor_total: 91.89, parcelas_total: 3, dia_vencimento: 20 };
  let r = await rota({ caminho: '/', corpo: { ...novo, categoria: 'seguros' } });
  eq(r.status, 200, '§2 cria com categoria');
  eq(r.log.inserts[0]?.obj.categoria, 'Seguros', '§2 grava a grafia oficial');
  r = await rota({ caminho: '/', corpo: { ...novo } });
  ok(!('categoria' in (r.log.inserts[0]?.obj || {})), '§2 sem categoria no pedido: nada muda no insert');
  r = await rota({ caminho: '/', corpo: { ...novo, categoria: 'Inventada' } });
  eq([r.status, r.log.inserts.length], [400, 0], '§2 categoria inexistente: 400 e nada gravado');
  r = await rota({ caminho: '/', corpo: { ...novo, categoria: 'Seguros', imagem_url: 'data:image/jpeg;base64,FOTO' }, cfg: { semColuna: true } });
  eq(r.status, 200, '§2 migration pendente: a dívida é criada mesmo assim');
  eq(r.log.inserts[0]?.obj.imagem_url, 'data:image/jpeg;base64,FOTO', '§2 migration pendente: a FOTO não se perde');
  ok(!('categoria' in (r.log.inserts[0]?.obj || {})), '§2 migration pendente: grava sem a categoria');

  // ── §3. Editar dívida ─────────────────────────────────────────────────────
  r = await rota({ caminho: '/:id', metodo: 'put', params: { id: 'd1' }, corpo: { categoria: 'Seguros' } });
  eq(r.t.dividas[0].categoria, 'Seguros', '§3 edita a categoria');
  r = await rota({ caminho: '/:id', metodo: 'put', params: { id: 'd1' }, corpo: { categoria: '' }, tabelas: { dividas: [DIV({ categoria: 'Seguros' })] } });
  eq(r.t.dividas[0].categoria, null, '§3 vazio volta ao padrão');
  r = await rota({ caminho: '/:id', metodo: 'put', params: { id: 'd1' }, corpo: { titulo: 'Seguro Casa' }, tabelas: { dividas: [DIV({ categoria: 'Seguros' })] } });
  eq(r.t.dividas[0].categoria, 'Seguros', '§3 editar outro campo não apaga a categoria');
  r = await rota({ caminho: '/:id', metodo: 'put', params: { id: 'd1' }, corpo: { categoria: 'Salário' } });
  eq([r.status, r.t.dividas[0].categoria], [400, undefined], '§3 categoria de receita: 400 e nada muda');
  r = await rota({ caminho: '/:id', metodo: 'put', params: { id: 'd1' }, corpo: { categoria: 'Seguros', titulo: 'Seguro Casa', imagem_url: 'data:image/jpeg;base64,NOVA' }, cfg: { semColuna: true } });
  eq([r.status, r.t.dividas[0].titulo, r.t.dividas[0].imagem_url], [200, 'Seguro Casa', 'data:image/jpeg;base64,NOVA'], '§3 migration pendente: salva o resto, inclusive a foto');

  // ── §4. Pagar parcela e quitar: o lançamento entra na categoria ───────────
  r = await rota({ caminho: '/:id/pagar', params: { id: 'd1' }, corpo: { valor: 30.63, wallet_id: 'w1' }, tabelas: { dividas: [DIV({ categoria: 'Seguros' })] } });
  eq(r.debitos[0]?.categoria, 'Seguros', '§4 pagar parcela: lançamento em "Seguros"');
  eq(r.debitos[0]?.observacao, 'Pagamento: Seguro Residencial Bradesco', '§4 a descrição "Pagamento: <título>" não muda (regra do custo mensal depende dela)');
  r = await rota({ caminho: '/:id/pagar', params: { id: 'd1' }, corpo: { valor: 30.63, wallet_id: 'w1' } });
  eq(r.debitos[0]?.categoria, 'Dívidas', '§4 dívida sem categoria: "Dívidas", como antes');
  r = await rota({ caminho: '/:id/quitar', params: { id: 'd1' }, corpo: { wallet_id: 'w1' }, tabelas: { dividas: [DIV({ categoria: 'Seguros' })] } });
  eq(r.debitos[0]?.categoria, 'Seguros', '§4 quitar: lançamento em "Seguros"');
  r = await rota({ caminho: '/:id/quitar', params: { id: 'd1' }, corpo: { wallet_id: 'w1' } });
  eq(r.debitos[0]?.categoria, 'Dívidas', '§4 quitar sem categoria: "Dívidas"');

  // ── §5. Travas de grupo ───────────────────────────────────────────────────
  r = await rota({ caminho: '/:id/quitar', params: { id: 'd1' }, corpo: { wallet_id: 'w1' }, tabelas: { dividas: [DIV({ grupo_id: 'g2' })] } });
  eq([r.status, r.t.dividas[0].status, r.debitos.length, r.t.divida_pagamentos.length], [404, 'ativa', 0, 0], '§5 quitar dívida de outro grupo: 404 e nada muda');
  r = await rota({ caminho: '/:id/lembrete', metodo: 'patch', params: { id: 'd1' }, corpo: { ativo: true }, tabelas: { dividas: [DIV({ grupo_id: 'g2', lembretes_ativos: false })] } });
  eq(r.t.dividas[0].lembretes_ativos, false, '§5 lembrete de dívida de outro grupo não é alterado');
  r = await rota({ caminho: '/:id/lembrete', metodo: 'patch', params: { id: 'd1' }, corpo: { ativo: true }, tabelas: { dividas: [DIV({ lembretes_ativos: false })] } });
  eq(r.t.dividas[0].lembretes_ativos, true, '§5 lembrete da própria dívida segue funcionando');

  if (falhas.length) {
    console.log(`✗ ${falhas.length} de ${casos} falharam:\n - ` + falhas.join('\n - '));
    process.exit(1);
  }
  console.log(`✓ categoria da dívida: ${casos} verificações ok`);
})();
